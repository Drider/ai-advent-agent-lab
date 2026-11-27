import { createError, defineEventHandler, getQuery, getRouterParam, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSchedulerRepository } from '../../scheduler/repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Schedule ID is required' })
  const repository = createSchedulerRepository(getChatDatabase())
  const job = repository.getJob(id)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Scheduled job not found' })
  const query = getQuery(event)
  const limit = Number(query.limit ?? 50)
  return {
    job,
    runs: repository.listRuns(id, Number.isFinite(limit) ? limit : 50),
    reports: repository.listReports(id, Number.isFinite(limit) ? limit : 50).map(report => ({ ...report, resultRunIds: repository.listReportRunIds(report.id) })),
  }
})
