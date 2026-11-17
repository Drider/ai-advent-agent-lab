import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createWorkingMemoryRepository } from '../../../memory/working-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const projectId = single(query.projectId as string | string[] | undefined)
  if (!projectId) throw createError({ statusCode: 400, statusMessage: 'projectId is required' })
  const rawLimit = single(query.limit as string | string[] | undefined)
  const limit = rawLimit === undefined ? undefined : Number(rawLimit)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw createError({ statusCode: 400, statusMessage: 'limit must be a positive integer' })
  try {
    return createWorkingMemoryRepository(getChatDatabase()).list(projectId, {
      cursor: single(query.cursor as string | string[] | undefined),
      limit,
      text: single(query.text as string | string[] | undefined),
      category: single(query.category as string | string[] | undefined),
    })
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
