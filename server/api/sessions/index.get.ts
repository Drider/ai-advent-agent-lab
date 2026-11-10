import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { ChatStorageError, createSessionRepository } from '../../persistence/session-repository'

function getSingleQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const cursor = getSingleQueryValue(query.cursor as string | string[] | undefined)
  const rawLimit = getSingleQueryValue(query.limit as string | string[] | undefined)
  let normalizedLimit: number | undefined

  if (rawLimit !== undefined) {
    const parsedLimit = Number(rawLimit)
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw createError({ statusCode: 400, statusMessage: 'limit must be a positive integer' })
    }
    normalizedLimit = parsedLimit
  }

  try {
    return createSessionRepository(getChatDatabase()).listSessions({ limit: normalizedLimit, cursor })
  } catch (error) {
    if (error instanceof ChatStorageError && error.code === 'INVALID_CURSOR') {
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    throw error
  }
})
