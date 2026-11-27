import type { PeriodReport, ScheduledJob } from '../../shared/scheduler'
import type { SchedulerPeriodItem, SchedulerPeriodPage } from './mcp-runner'

export interface ReportBuilderInput {
  reportId: string
  job: ScheduledJob
  from: string
  to: string
  readPeriod: (input: { jobId: string; from: string; to: string; cursor?: string; limit?: number }) => Promise<SchedulerPeriodPage>
  addMembers: (reportId: string, runIds: string[]) => void
  counts: (jobId: string, from: string, to: string) => Pick<PeriodReport, 'runCount' | 'successCount' | 'failureCount' | 'missedCount'>
  summarizeChunk: (input: { job: ScheduledJob; from: string; to: string; items: SchedulerPeriodItem[] }) => Promise<string>
  combineSummaries: (input: { job: ScheduledJob; from: string; to: string; chunks: string[] }) => Promise<string>
}

export async function buildPeriodReport(input: ReportBuilderInput): Promise<{ report: PeriodReport; resultRunIds: string[] }> {
  const resultRunIds: string[] = []
  const chunks: string[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  try {
    do {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw new Error('read_period returned a repeated cursor')
        seenCursors.add(cursor)
      }
      const page = await input.readPeriod({ jobId: input.job.id, from: input.from, to: input.to, ...(cursor ? { cursor } : {}), limit: 100 })
      const ids = page.items.map(item => item.runId)
      input.addMembers(input.reportId, ids)
      resultRunIds.push(...ids)
      for (let index = 0; index < page.items.length; index += 20) {
        const chunk = page.items.slice(index, index + 20)
        chunks.push(await input.summarizeChunk({ job: input.job, from: input.from, to: input.to, items: chunk }))
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)

    const counters = input.counts(input.job.id, input.from, input.to)
    const text = chunks.length === 0
      ? 'За период сохранённых результатов нет.'
      : chunks.length === 1
        ? chunks[0]!
        : await input.combineSummaries({ job: input.job, from: input.from, to: input.to, chunks })
    return {
      report: {
        id: input.reportId, jobId: input.job.id, scheduledFor: input.to, from: input.from, to: input.to,
        status: 'completed', ...counters, resultCount: resultRunIds.length, text, textStatus: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      },
      resultRunIds,
    }
  } catch (error) {
    const counters = input.counts(input.job.id, input.from, input.to)
    return {
      report: {
        id: input.reportId, jobId: input.job.id, scheduledFor: input.to, from: input.from, to: input.to,
        status: 'failed', ...counters, resultCount: resultRunIds.length, textStatus: 'failed', error: error instanceof Error ? error.message : String(error), createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      },
      resultRunIds,
    }
  }
}
