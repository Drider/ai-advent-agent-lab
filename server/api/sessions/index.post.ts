import { createError, defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSessionRepository } from '../../persistence/session-repository'
import { MemoryError } from '../../memory/errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = await readBody(event).catch(() => undefined) as unknown
  const projectId = body && typeof body === 'object' && 'projectId' in body && typeof body.projectId === 'string'
    ? body.projectId
    : undefined
  try {
    return createSessionRepository(getChatDatabase()).createSession({ projectId })
  } catch (error) {
    if (error instanceof MemoryError && error.code === 'NOT_FOUND') throw createError({ statusCode: 404, statusMessage: error.message })
    throw error
  }
})
