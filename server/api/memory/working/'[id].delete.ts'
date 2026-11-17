import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createWorkingMemoryRepository } from '../../../memory/working-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'memory entry id is required' })
  try {
    createWorkingMemoryRepository(getChatDatabase()).remove(id)
    return { deleted: true }
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
