import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createProjectRepository } from '../../persistence/project-repository'
import { MemoryError } from '../../memory/errors'

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  try {
    return createProjectRepository(getChatDatabase()).list({
      cursor: single(query.cursor as string | string[] | undefined),
      limit: query.limit === undefined ? undefined : Number(single(query.limit as string | string[] | undefined)),
      text: single(query.text as string | string[] | undefined),
    })
  } catch (error) {
    if (error instanceof MemoryError) throw createError({ statusCode: 400, statusMessage: error.message })
    throw error
  }
})
