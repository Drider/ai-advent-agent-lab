import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createInvariantRepository, InvariantRepositoryError } from '../../persistence/invariant-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 404, statusMessage: 'Invariant not found' })
  try {
    const repository = createInvariantRepository(getChatDatabase())
    if (!repository.remove(id)) throw createError({ statusCode: 404, statusMessage: 'Invariant not found' })
    return { id, deleted: true, changes: repository.listChanges(50) }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    if (error instanceof InvariantRepositoryError) {
      throw createError({ statusCode: error.code === 'NOT_FOUND' ? 404 : 400, statusMessage: error.message, data: { code: error.code } })
    }
    throw createError({ statusCode: 500, statusMessage: 'Invariant operation failed', cause: error })
  }
})
