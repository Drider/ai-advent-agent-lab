import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { BranchRepositoryError, createBranchRepository } from '../../../persistence/branch-repository'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const parentSessionId = getRouterParam(event, 'id')
  const body = await readBody(event) as unknown
  const throughMessageId = typeof body === 'object' && body !== null && 'throughMessageId' in body && typeof body.throughMessageId === 'string'
    ? body.throughMessageId
    : undefined
  if (!parentSessionId || !throughMessageId) throw createError({ statusCode: 400, statusMessage: 'throughMessageId is required' })

  try {
    return createBranchRepository(getChatDatabase()).createBranch({ parentSessionId, throughMessageId })
  } catch (error) {
    if (error instanceof BranchRepositoryError) {
      const statusCode = error.code === 'SESSION_NOT_FOUND' ? 404 : error.code === 'SESSION_RUNNING' ? 409 : 400
      throw createError({ statusCode, statusMessage: error.message })
    }
    throw error
  }
})
