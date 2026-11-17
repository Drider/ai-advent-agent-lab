import { createError, defineEventHandler, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createLongTermMemoryRepository } from '../../../memory/long-term-repository'
import { toMemoryHttpError } from '../../../memory/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = await readBody(event) as { projectId?: unknown }
  if (!body || typeof body.projectId !== 'string' || body.projectId.length === 0) throw createError({ statusCode: 400, statusMessage: 'projectId is required' })
  try {
    return { detached: createLongTermMemoryRepository(getChatDatabase()).detachProject(body.projectId) }
  } catch (error) {
    throw toMemoryHttpError(error)
  }
})
