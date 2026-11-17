import { createError, defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createProjectRepository } from '../../../persistence/project-repository'
import { MemoryError } from '../../../memory/errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  const body = await readBody(event) as unknown
  const projectId = body && typeof body === 'object' && 'projectId' in body && typeof body.projectId === 'string' ? body.projectId : undefined
  if (!sessionId || !projectId) throw createError({ statusCode: 400, statusMessage: 'projectId is required' })
  try {
    createProjectRepository(getChatDatabase()).assignSession(sessionId, projectId)
    return { projectId }
  } catch (error) {
    if (error instanceof MemoryError) {
      const statusCode = error.code === 'NOT_FOUND' ? 404 : error.code === 'SESSION_RUNNING' || error.code === 'PROJECT_ALREADY_ASSIGNED' || error.code === 'HISTORY_CLEAR_PENDING' ? 409 : 400
      throw createError({ statusCode, statusMessage: error.message })
    }
    throw error
  }
})
