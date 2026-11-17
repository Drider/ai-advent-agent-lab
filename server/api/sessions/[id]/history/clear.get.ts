import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../../../persistence/db'
import { createHistoryClearRepository } from '../../../../memory/clear-repository'
import { toMemoryHttpError } from '../../../../memory/api-errors'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  if (!sessionId) throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  const db = getChatDatabase()
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }
  try {
    return createHistoryClearRepository(db).pendingForSession(sessionId) ?? null
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
