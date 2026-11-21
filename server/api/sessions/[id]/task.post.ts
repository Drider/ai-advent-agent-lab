import { defineEventHandler, getRouterParam, readBody, setHeader } from 'h3'
import { getChatDatabase } from '../../../persistence/db'
import { createTaskRepository } from '../../../persistence/task-repository'
import { invalidTaskRequest, toTaskHttpError } from '../../../tasks/api-errors'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const sessionId = getRouterParam(event, 'id')
  if (!sessionId) throw invalidTaskRequest(new Error('session was not specified'))
  let body: unknown
  try {
    body = await readBody(event, { strict: true })
    if (typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'templateId') || !Object.hasOwn(body, 'goal')) {
      throw new Error('request must contain only templateId and goal')
    }
  } catch (error) {
    throw invalidTaskRequest(error)
  }
  try {
    const tasks = createTaskRepository(getChatDatabase())
    tasks.start(sessionId, body)
    return { task: tasks.getSnapshot(sessionId)! }
  } catch (error) {
    throw toTaskHttpError(error)
  }
})
