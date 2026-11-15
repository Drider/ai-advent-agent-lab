import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { validateContextStrategySettings } from '../../../../shared/chat'
import { getChatDatabase } from '../../../persistence/db'
import { ChatStorageError, createSessionRepository } from '../../../persistence/session-repository'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'Session not found' })

  let settings
  try {
    settings = validateContextStrategySettings(await readBody(event))
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid context strategy settings' })
  }

  try {
    createSessionRepository(getChatDatabase()).setContextStrategySettings(id, settings)
  } catch (error) {
    if (error instanceof ChatStorageError && error.code === 'SESSION_NOT_FOUND') {
      throw createError({ statusCode: 404, statusMessage: 'Session not found' })
    }
    throw error
  }
  return settings
})
