import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { listMemoryChanges } from '../../memory/change-log'
import { toMemoryHttpError } from '../../memory/api-errors'

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const rawLimit = single(query.limit as string | string[] | undefined)
  const limit = rawLimit === undefined ? 20 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1) throw createError({ statusCode: 400, statusMessage: 'limit must be a positive integer' })
  try {
    return listMemoryChanges(getChatDatabase(), {
      projectId: single(query.projectId as string | string[] | undefined),
      limit,
    })
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
