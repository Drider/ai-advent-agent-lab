import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createWorkingMemoryRepository } from '../../../memory/working-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'memory entry id is required' })
  try {
    return createWorkingMemoryRepository(getChatDatabase()).update(id, await readBody(event))
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
