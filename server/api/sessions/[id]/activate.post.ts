import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { ChatStorageError, createSessionRepository } from '../../../persistence/session-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }

  try {
    const repository = createSessionRepository(getChatDatabase())
    repository.activateSession(id)
    return { ok: true, sessionId: id }
  } catch (error) {
    if (error instanceof ChatStorageError && error.code === 'SESSION_NOT_FOUND') {
      throw createError({ statusCode: 404, statusMessage: 'Session not found' })
    }
    throw error
  }
})
