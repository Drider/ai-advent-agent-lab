import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import {
  validateForbiddenPatterns,
  validateInvariantCategory,
  validateInvariantRule,
  type InvariantCategory,
} from '../../../shared/invariant'
import { getChatDatabase } from '../../persistence/db'
import { createInvariantRepository, InvariantRepositoryError } from '../../persistence/invariant-repository'

function invalid(error: unknown): Error {
  return createError({
    statusCode: 400,
    statusMessage: error instanceof Error ? error.message : 'Invalid invariant request',
    data: { code: 'INVALID_INPUT' },
  })
}

function toHttpError(error: unknown): Error {
  if (!(error instanceof InvariantRepositoryError)) return error instanceof Error ? error : createError({ statusCode: 500, statusMessage: 'Invariant operation failed' })
  return createError({
    statusCode: error.code === 'NOT_FOUND' ? 404 : 400,
    statusMessage: error.message,
    data: { code: error.code },
  })
}

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'Invariant not found' })

  let body: Record<string, unknown>
  try {
    const raw = await readBody(event, { strict: true }) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('request must be an object')
    body = raw as Record<string, unknown>
    const allowedKeys = ['rule', 'category', 'forbidden']
    if (Object.keys(body).some(key => !allowedKeys.includes(key))) throw new Error('request contains unexpected keys')
    if (!Object.hasOwn(body, 'rule') && !Object.hasOwn(body, 'forbidden')) throw new Error('rule or forbidden is required')
    if (body.rule !== undefined) validateInvariantRule(body.rule)
    if (body.category !== undefined) validateInvariantCategory(body.category)
    if (body.forbidden !== undefined) validateForbiddenPatterns(body.forbidden)
  } catch (error) {
    throw invalid(error)
  }

  try {
    const repository = createInvariantRepository(getChatDatabase())
    const invariant = body.rule !== undefined
      ? repository.upsert({
          id,
          rule: body.rule as string,
          ...(body.category === undefined ? {} : { category: body.category as InvariantCategory }),
          ...(body.forbidden === undefined ? {} : { forbidden: body.forbidden as string[] }),
        })
      : repository.setForbidden(id, body.forbidden)
    return { invariant, changes: repository.listChanges(50) }
  } catch (error) {
    throw toHttpError(error)
  }
})
