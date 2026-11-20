import { createError, defineEventHandler, getHeader, getQuery, getRouterParam, readRawBody, setHeader, type H3Event } from 'h3'
import { z } from 'zod'
import type { TaskCommandResult, TaskErrorCode } from '../../shared/task'
import { getChatDatabase } from '../persistence/db'
import { UserProfileError } from '../persistence/user-profile-repository'
import { toUserProfileHttpError } from '../user-profiles/api-errors'
import { TaskError, WorkflowSchemaError } from './errors'

const statuses: Record<TaskErrorCode, number> = {
  INVALID_INPUT: 400, NOT_FOUND: 404, TASK_ALREADY_ACTIVE: 409, TASK_PAUSED: 409, TASK_CANCELLED: 409,
  TASK_TERMINAL: 409, STALE_TASK_REVISION: 409, TRANSITION_NOT_ALLOWED: 422, PLAN_APPROVAL_REQUIRED: 422,
  VALIDATION_REQUIRED: 422, RECOVERY_REVIEW_REQUIRED: 409, SESSION_RUNNING: 409, OPERATION_CONFLICT: 409, CONTEXT_LIMIT: 422,
}

export function taskHttpError(error: TaskError) {
  return createError({ statusCode: statuses[error.code], statusMessage: error.message, data: { code: error.code } })
}

export function commandResponse(result: TaskCommandResult) {
  if (!result.ok) throw createError({ statusCode: statuses[result.error.code], statusMessage: result.error.message, data: result })
  return result
}

export function taskRoute<T>(handler: (event: H3Event, db: ReturnType<typeof getChatDatabase>) => T) {
  return defineEventHandler(async event => {
    setHeader(event, 'Cache-Control', 'no-store')
    try {
      return await handler(event, getChatDatabase())
    } catch (error) {
      if (error instanceof WorkflowSchemaError) throw createError({ statusCode: 422, statusMessage: error.message,
        data: { valid: false, errors: error.issues } })
      if (error instanceof TaskError) throw taskHttpError(error)
      if (error instanceof UserProfileError) throw toUserProfileHttpError(error)
      throw error
    }
  })
}

export async function taskBody<S extends z.ZodType>(event: H3Event, schema: S): Promise<z.output<S>> {
  let body: unknown
  if (getHeader(event, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new TaskError('INVALID_INPUT', 'Expected application/json')
  }
  try { body = JSON.parse(await readRawBody(event) ?? '') }
  catch { throw new TaskError('INVALID_INPUT', 'Expected a JSON object') }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new TaskError('INVALID_INPUT', 'Invalid request: ' + parsed.error.issues.map(issue => issue.path.join('.') || issue.message).join(', '))
  return parsed.data
}

export function routeId(event: H3Event, key = 'id') {
  const id = getRouterParam(event, key)
  if (!id) throw new TaskError('NOT_FOUND', 'Resource was not found')
  return id
}

export function dialogueId(event: H3Event) {
  const query = z.strictObject({ sessionId: identifier }).safeParse(getQuery(event))
  if (!query.success) throw new TaskError('INVALID_INPUT', 'Expected a sessionId query parameter')
  return query.data.sessionId
}

export const identifier = z.string().min(1).max(200).regex(/^[\w-]+$/)
export const operationFields = { operationId: identifier, expectedRevision: z.number().int().nonnegative() }
export const versionFields = { workflowId: identifier, version: z.number().int().positive() }
export const sourceFields = { source: z.string(), format: z.enum(['json', 'yaml']) }
