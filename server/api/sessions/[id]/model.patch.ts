import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { validateModelId } from '../../../../shared/chat'
import { getChatDatabase } from '../../../persistence/db'
import { ChatStorageError, createSessionRepository } from '../../../persistence/session-repository'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }

  const body = await readBody(event) as unknown
  let modelId: string
  try {
    modelId = validateModelId(body && typeof body === 'object' && 'modelId' in body ? body.modelId : undefined)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid model ID' })
  }

  try {
    createSessionRepository(getChatDatabase()).setModelId(id, modelId)
  } catch (error) {
    if (error instanceof ChatStorageError && error.code === 'SESSION_NOT_FOUND') {
      throw createError({ statusCode: 404, statusMessage: 'Session not found' })
    }
    throw error
  }

  return { modelId }
})
