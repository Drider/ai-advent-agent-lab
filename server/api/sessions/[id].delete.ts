import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { ChatStorageError, createSessionRepository } from '../../persistence/session-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }

  try {
    createSessionRepository(getChatDatabase()).deleteSession(id)
    return { ok: true }
  } catch (error) {
    if (error instanceof ChatStorageError) {
      if (error.code === 'SESSION_NOT_FOUND') {
        throw createError({ statusCode: 404, statusMessage: 'Session not found' })
      }
      if (error.code === 'SESSION_RUNNING') {
        throw createError({ statusCode: 409, statusMessage: 'Session is running' })
      }
    }
    throw error
  }
})
