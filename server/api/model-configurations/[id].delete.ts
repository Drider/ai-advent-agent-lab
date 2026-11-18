import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createModelConfigurationRepository } from '../../persistence/model-configuration-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'Model configuration not found' })

  const deleted = createModelConfigurationRepository(getChatDatabase()).delete(id)
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Model configuration not found' })
  return { id, deleted: true }
})
