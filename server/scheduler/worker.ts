import { randomUUID } from 'node:crypto'
import { nextOccurrence, previousOccurrence } from './schedule'
import { buildPeriodReport } from './report'
import type { ScheduledJob } from '../../shared/scheduler'
import type { createSchedulerRepository } from './repository'
import { createSchedulerMcpRunner } from './mcp-runner'
import { parseSchedulerMcpServer } from './config'
import type { McpServerConfig } from '../mcp/client'
import type { LanguageModel } from 'ai'
import { combineReportChunks, summarizeReportChunk } from './summarizer'

type SchedulerRepository = ReturnType<typeof createSchedulerRepository>
type SchedulerRunner = ReturnType<typeof createSchedulerMcpRunner>

export interface SchedulerWorkerOptions {
  repository: SchedulerRepository
  mcpRunnerFactory?: (server: McpServerConfig) => SchedulerRunner
  mcpServer?: McpServerConfig
  modelForReport: (job: ScheduledJob) => LanguageModel
  clock?: () => Date
  tickMs?: number
  collectGraceMs?: number
}

export function createSchedulerWorker(options: SchedulerWorkerOptions) {
  const ownerId = randomUUID()
  const clock = options.clock ?? (() => new Date())
  const tickMs = options.tickMs ?? 15_000
  const collectGraceMs = options.collectGraceMs ?? 5 * 60_000
  const leaseTtlMs = 5 * 60_000
  const runner = (options.mcpRunnerFactory ?? (server => createSchedulerMcpRunner({ server })))(options.mcpServer ?? parseSchedulerMcpServer())
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  let stopped = false

  async function collect(job: ScheduledJob, now: Date): Promise<void> {
    let next: Date
    try { next = nextOccurrence(job.collectCron, job.timezone, new Date(job.nextCollectAt)) } catch (error) { options.repository.updateNextCollect(job.id, new Date(now.getTime() + 24 * 60 * 60_000).toISOString()); console.error('[scheduler] invalid collect schedule', error); return }
    const run = options.repository.claimRun(job.id, job.nextCollectAt, now)
    options.repository.updateNextCollect(job.id, next.toISOString())
    if (!run) return
    if (now.getTime() - Date.parse(run.scheduledFor) > collectGraceMs) {
      options.repository.markMissed(run.id, 'worker was more than five minutes late', now)
      return
    }
    try {
      const data = await runner.getData({ sourceId: job.sourceId, query: job.sourceQuery })
      await runner.saveResult({ runId: run.id, payload: data.payload, observedAt: data.observedAt })
      options.repository.finishRun(run.id, { status: 'completed', observedAt: data.observedAt }, now)
    } catch (error) {
      options.repository.finishRun(run.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, now)
    }
  }

  async function report(job: ScheduledJob, now: Date): Promise<void> {
    const scheduledFor = job.nextReportAt
    const periodFrom = previousOccurrence(job.reportCron, job.timezone, new Date(scheduledFor)).toISOString()
    const reportRow = options.repository.claimReport(job.id, scheduledFor, periodFrom, scheduledFor, now)
    if (!reportRow) {
      options.repository.updateNextReport(job.id, nextOccurrence(job.reportCron, job.timezone, new Date(scheduledFor)).toISOString())
      return
    }
    options.repository.clearReportMembers(reportRow.id)
    const result = await buildPeriodReport({
      reportId: reportRow.id,
      job,
      from: periodFrom,
      to: scheduledFor,
      readPeriod: input => runner.readPeriod(input),
      addMembers: (id, runIds) => options.repository.addReportMembers(id, runIds),
      counts: (id, from, to) => options.repository.counts(id, from, to),
      summarizeChunk: input => summarizeReportChunk({ ...input, model: options.modelForReport(job) }),
      combineSummaries: input => combineReportChunks({ ...input, model: options.modelForReport(job) }),
    })
    options.repository.finishReport(reportRow.id, result.report.status === 'completed'
      ? { status: 'completed', runCount: result.report.runCount, successCount: result.report.successCount, failureCount: result.report.failureCount, missedCount: result.report.missedCount, resultCount: result.report.resultCount, text: result.report.text, textStatus: result.report.textStatus }
      : { status: 'failed', runCount: result.report.runCount, successCount: result.report.successCount, failureCount: result.report.failureCount, missedCount: result.report.missedCount, resultCount: result.report.resultCount, textStatus: 'failed', error: result.report.error })
    options.repository.updateNextReport(job.id, nextOccurrence(job.reportCron, job.timezone, new Date(scheduledFor)).toISOString())
  }

  async function tick(): Promise<void> {
    if (stopped || running) return
    running = true
    const now = clock()
    try {
      if (!options.repository.acquireLease(ownerId, now, leaseTtlMs)) return
      options.repository.recoverRunningRuns(now)
      options.repository.deliverPendingReports()
      for (const initialJob of options.repository.listJobs().filter(job => job.status === 'active')) {
        let job = initialJob
        let collectGuard = 0
        while (Date.parse(job.nextCollectAt) <= now.getTime() && collectGuard < 100) {
          await collect(job, now)
          const updatedJob = options.repository.getJob(job.id)
          if (!updatedJob) break
          job = updatedJob
          collectGuard += 1
        }
        if (!options.repository.getJob(initialJob.id)) continue
        let reportGuard = 0
        while (Date.parse(job.nextReportAt) <= now.getTime() && reportGuard < 20) {
          await report(job, now)
          const updatedJob = options.repository.getJob(job.id)
          if (!updatedJob) break
          job = updatedJob
          reportGuard += 1
        }
        options.repository.renewLease(ownerId, clock(), leaseTtlMs)
      }
      options.repository.renewLease(ownerId, clock(), leaseTtlMs)
    } finally { running = false }
  }

  function start(): void {
    if (timer !== undefined || stopped) return
    void tick()
    timer = setInterval(() => { void tick() }, tickMs)
  }

  async function stop(): Promise<void> {
    stopped = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    while (running) await new Promise(resolve => setTimeout(resolve, 5))
    options.repository.releaseLease(ownerId)
    await runner.close()
  }

  return { start, stop, tick }
}
