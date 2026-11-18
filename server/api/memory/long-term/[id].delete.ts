import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createLongTermMemoryRepository } from '../../../memory/long-term-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'memory fact id is required' })
  try {
    createLongTermMemoryRepository(getChatDatabase()).remove(id)
    return { deleted: true }
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
