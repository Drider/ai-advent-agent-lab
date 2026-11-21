import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSessionRepository } from '../../persistence/session-repository'
import { createTaskRepository } from '../../tasks/repository'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }

  const db = getChatDatabase()
  const { resumeRequestId, resumeTaskId } = getQuery(event)
  let acceptedResumeTurn: boolean | undefined
  if (resumeRequestId !== undefined || resumeTaskId !== undefined) {
    if (typeof resumeRequestId !== 'string' || typeof resumeTaskId !== 'string') {
      throw createError({ statusCode: 400, statusMessage: 'Expected a resume request and task ID' })
    }
    acceptedResumeTurn = createTaskRepository(db).getTurn(resumeRequestId, id)?.task_id === resumeTaskId
  }
  const session = await createSessionRepository(db).getSession(id)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }
  return acceptedResumeTurn === undefined ? session : { ...session, acceptedResumeTurn }
})
