import { createError, defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createProjectRepository } from '../../persistence/project-repository'
import { MemoryError } from '../../memory/errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = await readBody(event) as unknown
  const name = body && typeof body === 'object' && 'name' in body && typeof body.name === 'string' ? body.name : undefined
  try {
    return createProjectRepository(getChatDatabase()).create(name ?? '')
  } catch (error) {
    if (error instanceof MemoryError) throw createError({ statusCode: 400, statusMessage: error.message })
    throw error
  }
})
