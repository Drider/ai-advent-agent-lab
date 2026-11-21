import { defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createTaskRepository } from '../../../persistence/task-repository'
import { invalidTaskRequest, toTaskHttpError } from '../../../tasks/api-errors'

type TaskAction = 'approve' | 'reject' | 'pause' | 'resume' | 'cancel'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  if (!sessionId) throw invalidTaskRequest(new Error('session was not specified'))

  let action: TaskAction
  let stage: string | undefined
  let pendingTransitionId: string | undefined
  let expectedRevision: number | undefined
  let expectedProfileName: string | undefined
  try {
    const rawBody = await readBody(event, { strict: true }) as unknown
    if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
      throw new Error('request must contain a valid action')
    }
    const record = rawBody as Record<string, unknown>
    if (!Object.hasOwn(record, 'action') || typeof record.action !== 'string'
      || !['approve', 'reject', 'pause', 'resume', 'cancel'].includes(record.action)) {
      throw new Error('request must contain a valid action')
    }
    action = record.action as TaskAction
    const allowedKeys = action === 'approve'
      ? ['action', 'stage', 'pendingTransitionId', 'expectedRevision', 'expectedProfileName']
      : action === 'reject'
        ? ['action', 'stage', 'pendingTransitionId', 'expectedRevision']
      : ['action']
    if (Object.keys(record).some(key => !allowedKeys.includes(key))) throw new Error('request contains unexpected keys')
    if (action === 'approve' || action === 'reject') {
      if (record.stage !== undefined && (typeof record.stage !== 'string' || !record.stage.trim())) {
        throw new Error('stage must be a non-empty string')
      }
      if (record.pendingTransitionId !== undefined
        && (typeof record.pendingTransitionId !== 'string' || !record.pendingTransitionId.trim())) {
        throw new Error('pendingTransitionId must be a non-empty string')
      }
      if (record.expectedRevision !== undefined
        && (typeof record.expectedRevision !== 'number'
          || !Number.isSafeInteger(record.expectedRevision)
          || record.expectedRevision < 0)) {
        throw new Error('expectedRevision must be a non-negative integer')
      }
      if (record.stage === undefined && record.pendingTransitionId === undefined) {
        throw new Error('stage or pendingTransitionId is required for this action')
      }
      stage = record.stage as string | undefined
      pendingTransitionId = record.pendingTransitionId as string | undefined
      expectedRevision = record.expectedRevision as number | undefined
      if (action === 'approve') {
        if (record.expectedProfileName !== undefined
          && (typeof record.expectedProfileName !== 'string' || !record.expectedProfileName.trim())) {
          throw new Error('expectedProfileName must be a non-empty string')
        }
        expectedProfileName = record.expectedProfileName as string | undefined
      }
    }
  } catch (error) {
    throw invalidTaskRequest(error)
  }

  try {
    const tasks = createTaskRepository(getChatDatabase())
    const transitionInput = {
      ...(stage === undefined ? {} : { stage }),
      ...(pendingTransitionId === undefined ? {} : { pendingTransitionId }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(expectedProfileName === undefined ? {} : { expectedProfileName }),
    }
    const task = action === 'approve'
      ? tasks.approve(sessionId, transitionInput)
      : action === 'reject'
        ? tasks.reject(sessionId, transitionInput)
        : action === 'pause'
          ? tasks.pause(sessionId)
          : action === 'resume'
            ? tasks.resume(sessionId)
            : tasks.cancel(sessionId)
    return { task }
  } catch (error) {
    throw toTaskHttpError(error)
  }
})
