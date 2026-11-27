import { createError, defineEventHandler, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSchedulerRepository } from '../../scheduler/repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Schedule ID is required' })

  const result = createSchedulerRepository(getChatDatabase()).deleteJob(id)
  if (result === 'not_found') throw createError({ statusCode: 404, statusMessage: 'Scheduled job not found' })
  if (result === 'busy') throw createError({ statusCode: 409, statusMessage: 'The scheduled job has a run or report in progress' })

  return { id, deleted: true }
})
