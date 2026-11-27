import type Database from 'better-sqlite3'
import { tool } from 'ai'
import { z } from 'zod'
import { nextOccurrence } from '../../scheduler/schedule'
import { parseSchedulerSources } from '../../scheduler/config'
import { createSchedulerRepository } from '../../scheduler/repository'
import { validateScheduledJob, validateSourceQuery, type SchedulerSourceConfig } from '../../../shared/scheduler'

const sourceQuerySchema = z.record(z.string(), z.string()).default({})

export type SchedulerTools = ReturnType<typeof createSchedulerTools>

export function createSchedulerTools(options: { db: Database.Database; sessionId?: string; sources?: SchedulerSourceConfig[]; now?: () => Date }) {
  const repository = createSchedulerRepository(options.db)
  const sources = options.sources ?? parseSchedulerSources(process.env.SCHEDULER_SOURCES_JSON)
  const sourceById = new Map(sources.map(source => [source.id, source]))
  const now = options.now ?? (() => new Date())

  return {
    list_scheduled_sources: tool({
      description: 'List the configured data sources available to scheduled jobs. Never invent a source ID or URL.',
      inputSchema: z.object({}).strict(),
      execute: async () => ({ sources: sources.map(source => ({ id: source.id, kind: source.kind, allowedQueryKeys: source.allowedQueryKeys })) }),
    }),
    create_scheduled_job: tool({
      description: 'Create a background scheduled data collection and report job. Reports are automatically posted to the chat where this job is created. Use list_scheduled_sources first; confirm exact schedules and timezone in the answer.',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(120),
        sourceId: z.string().trim().min(1),
        sourceQuery: sourceQuerySchema,
        collectCron: z.string().trim().min(9),
        reportCron: z.string().trim().min(9),
        timezone: z.string().trim().min(1).default(process.env.SCHEDULER_DEFAULT_TIMEZONE ?? 'Europe/Moscow'),
        summaryInstruction: z.string().trim().min(1).max(4_000),
        modelId: z.string().trim().min(1).max(200).optional(),
      }).strict(),
      execute: async input => {
        try {
          const source = sourceById.get(input.sourceId)
          if (!source) return { created: false as const, error: { code: 'UNKNOWN_SOURCE', message: `Unknown scheduler source: ${input.sourceId}` } }
          validateSourceQuery(source, input.sourceQuery)
          const validated = validateScheduledJob(input)
          const current = now()
          const nextCollectAt = nextOccurrence(validated.collectCron, validated.timezone, current).toISOString()
          const nextReportAt = nextOccurrence(validated.reportCron, validated.timezone, current).toISOString()
          const job = repository.createJob({ ...validated, nextCollectAt, nextReportAt, ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }) })
          return { created: true as const, job }
        } catch (error) {
          return { created: false as const, error: { code: 'INVALID_JOB', message: error instanceof Error ? error.message : String(error) } }
        }
      },
    }),
    list_scheduled_jobs: tool({
      description: 'List scheduled jobs with their exact status and next collection/report times.',
      inputSchema: z.object({}).strict(),
      execute: async () => ({ jobs: repository.listJobs() }),
    }),
    pause_scheduled_job: tool({
      description: 'Pause one scheduled job by its exact ID from list_scheduled_jobs.',
      inputSchema: z.object({ id: z.string().uuid() }).strict(),
      execute: async ({ id }) => { try { return { paused: true as const, job: repository.pauseJob(id) } } catch (error) { return { paused: false as const, error: { code: 'NOT_FOUND', message: error instanceof Error ? error.message : String(error) } } } },
    }),
    resume_scheduled_job: tool({
      description: 'Resume one paused scheduled job by its exact ID from list_scheduled_jobs.',
      inputSchema: z.object({ id: z.string().uuid() }).strict(),
      execute: async ({ id }) => { try { return { resumed: true as const, job: repository.resumeJob(id) } } catch (error) { return { resumed: false as const, error: { code: 'NOT_FOUND', message: error instanceof Error ? error.message : String(error) } } } },
    }),
    read_scheduled_reports: tool({
      description: 'Read reports already generated for a scheduled job. Reports include all persisted results from their period.',
      inputSchema: z.object({ jobId: z.string().uuid(), limit: z.number().int().min(1).max(100).default(20) }).strict(),
      execute: async ({ jobId, limit }) => ({ reports: repository.listReports(jobId, limit).map(report => ({ ...report, resultRunIds: repository.listReportRunIds(report.id) })) }),
    }),
  }
}
