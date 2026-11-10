import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSessionRepository } from '../../persistence/session-repository'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }

  const session = await createSessionRepository(getChatDatabase()).getSession(id)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }
  return session
})
