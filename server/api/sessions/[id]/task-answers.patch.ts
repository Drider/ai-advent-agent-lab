import { defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createTaskRepository } from '../../../persistence/task-repository'
import { invalidTaskRequest, toTaskHttpError } from '../../../tasks/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  if (!sessionId) throw invalidTaskRequest(new Error('session was not specified'))

  let body: { answers: Record<string, string>; expectedRevision: number }
  try {
    const raw = await readBody(event, { strict: true }) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
      || Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'answers') || !Object.hasOwn(raw, 'expectedRevision')) {
      throw new Error('request must contain only answers and expectedRevision')
    }
    const record = raw as Record<string, unknown>
    if (typeof record.answers !== 'object' || record.answers === null || Array.isArray(record.answers)) {
      throw new Error('answers must be an object')
    }
    if (typeof record.expectedRevision !== 'number' || !Number.isSafeInteger(record.expectedRevision) || record.expectedRevision < 0) {
      throw new Error('expectedRevision must be a non-negative integer')
    }
    body = { answers: record.answers as Record<string, string>, expectedRevision: record.expectedRevision }
  } catch (error) {
    throw invalidTaskRequest(error)
  }

  try {
    return { task: createTaskRepository(getChatDatabase()).saveAnswers(sessionId, body) }
  } catch (error) {
    throw toTaskHttpError(error)
  }
})
