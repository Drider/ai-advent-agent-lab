import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createSchedulerRepository } from '../../scheduler/repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const repository = createSchedulerRepository(getChatDatabase())
  return {
    items: repository.listJobs().map((job) => {
      const latestReport = repository.listReports(job.id, 1)[0] ?? null
      return {
        ...job,
        lastRuns: repository.listRuns(job.id, 5),
        latestReport: latestReport
          ? { ...latestReport, results: repository.listReportResults(latestReport.id, 50) }
          : null,
      }
    }),
  }
})
