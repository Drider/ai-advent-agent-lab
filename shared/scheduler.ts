import { z } from 'zod'

export const schedulerJobStatusSchema = z.enum(['active', 'paused'])
export type SchedulerJobStatus = z.infer<typeof schedulerJobStatusSchema>

export const schedulerRunStatusSchema = z.enum(['running', 'completed', 'failed', 'missed'])
export type SchedulerRunStatus = z.infer<typeof schedulerRunStatusSchema>

export const schedulerReportStatusSchema = z.enum(['running', 'completed', 'failed'])
export type SchedulerReportStatus = z.infer<typeof schedulerReportStatusSchema>

export interface SchedulerSourceConfig {
  id: string
  kind: 'clock' | 'http_json'
  url?: string
  allowedQueryKeys: string[]
}

export interface ScheduledJobInput {
  name: string
  sourceId: string
  sourceQuery: Record<string, string>
  collectCron: string
  reportCron: string
  timezone: string
  summaryInstruction: string
  modelId?: string
}

export interface ScheduledJob extends ScheduledJobInput {
  id: string
  sessionId?: string
  status: SchedulerJobStatus
  nextCollectAt: string
  nextReportAt: string
  createdAt: string
  updatedAt: string
}

export interface ScheduledRun {
  id: string
  jobId: string
  scheduledFor: string
  status: SchedulerRunStatus
  observedAt?: string
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface PeriodReport {
  id: string
  jobId: string
  scheduledFor: string
  from: string
  to: string
  status: SchedulerReportStatus
  runCount: number
  successCount: number
  failureCount: number
  missedCount: number
  resultCount: number
  text?: string
  textStatus: 'pending' | 'completed' | 'failed'
  error?: string
  resultRunIds?: string[]
  createdAt: string
  finishedAt?: string
}

export interface ScheduledReportResult {
  runId: string
  scheduledFor: string
  observedAt: string
  status: SchedulerRunStatus
  error?: string
  payload: unknown
}

export interface ScheduleReportView extends PeriodReport {
  results: ScheduledReportResult[]
}

export interface ScheduledJobView extends ScheduledJob {
  lastRuns: ScheduledRun[]
  latestReport: ScheduleReportView | null
}

const scheduledJobSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceId: z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/u),
  sourceQuery: z.record(z.string().trim().min(1).max(200), z.string().max(500)).default({}),
  collectCron: z.string().trim().min(9).max(100),
  reportCron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(100).default('Europe/Moscow'),
  summaryInstruction: z.string().trim().min(1).max(4_000),
  modelId: z.string().trim().min(1).max(200).optional(),
}).strict()

export function validateScheduledJob(input: unknown): ScheduledJobInput {
  return scheduledJobSchema.parse(input)
}

export function validateSourceQuery(source: SchedulerSourceConfig, query: Record<string, string>): void {
  for (const key of Object.keys(query)) {
    if (!source.allowedQueryKeys.includes(key)) {
      throw new Error(`source query key is not allowed: ${key}`)
    }
  }
}
