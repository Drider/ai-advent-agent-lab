import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createProjectRepository } from '../../persistence/project-repository'
import { MemoryError } from '../../memory/errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  const body = await readBody(event) as unknown
  const name = body && typeof body === 'object' && 'name' in body && typeof body.name === 'string' ? body.name : undefined
  const expectedRevision = body && typeof body === 'object' && 'expectedRevision' in body && typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
  if (!id || name === undefined || expectedRevision === undefined) throw createError({ statusCode: 400, statusMessage: 'name and expectedRevision are required' })
  try {
    return createProjectRepository(getChatDatabase()).rename(id, name, expectedRevision)
  } catch (error) {
    if (error instanceof MemoryError) {
      const statusCode = error.code === 'NOT_FOUND' ? 404 : error.code === 'REVISION_CONFLICT' ? 409 : 400
      throw createError({ statusCode, statusMessage: error.message })
    }
    throw error
  }
})
