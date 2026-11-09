import { z } from 'zod'

const dateTime = z.iso.datetime({ offset: true })
const usageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
}).passthrough()
const entrySchema = z.object({
  question: z.string(),
  answer: z.string().optional(),
  error: z.string().optional(),
  startedAt: dateTime,
  completedAt: dateTime,
  durationMs: z.number().nonnegative(),
  usage: usageSchema.optional(),
  request: z.object({ model: z.string().max(200).optional() }).passthrough().optional(),
  response: z.object({ modelId: z.string().max(200).optional() }).passthrough().optional(),
  steps: z.array(z.unknown()).optional(),
}).passthrough()
const sessionSchema = z.object({
  runId: dateTime.refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)),
  startedAt: dateTime,
  updatedAt: dateTime,
  level: z.enum(['basic', 'detailed', 'raw']),
  requests: z.array(entrySchema).max(5000),
}).passthrough()

export interface SessionEntry {
  question: string
  answer?: string
  error?: string
  startedAt: string
  durationMs: number
  model: string | null
  tools: string[] | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface SessionLog {
  runId: string
  startedAt: string
  updatedAt: string
  level: 'basic' | 'detailed' | 'raw'
  requests: SessionEntry[]
  source?: 'local' | 'uploaded'
  path?: string
}

function toolNames(steps: unknown[] | undefined): string[] {
  const names: string[] = []
  for (const step of steps ?? []) {
    if (typeof step !== 'object' || step === null || !('toolCalls' in step) || !Array.isArray(step.toolCalls)) continue
    for (const call of step.toolCalls) {
      if (typeof call === 'object' && call !== null && 'toolName' in call && typeof call.toolName === 'string' && call.toolName.length <= 100) {
        names.push(call.toolName)
      }
    }
  }
  return names
}

export function parseSessionLog(text: string): SessionLog {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Файл не содержит корректный JSON.')
  }
  const parsed = sessionSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error('Файл не соответствует формату JSON-лога сессии этого приложения.')
  }
  const session = parsed.data
  return {
    runId: session.runId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    level: session.level,
    requests: session.requests.map(entry => ({
      question: entry.question,
      answer: entry.answer,
      error: entry.error,
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      model: entry.request?.model ?? entry.response?.modelId ?? null,
      tools: entry.steps ? toolNames(entry.steps) : null,
      inputTokens: entry.usage?.inputTokens ?? 0,
      outputTokens: entry.usage?.outputTokens ?? 0,
      totalTokens: entry.usage?.totalTokens ?? 0,
    })),
  }
}

export type SessionGroupBy = 'day' | 'model' | 'tool' | 'session'
const MAX_GROUPS = 100

export interface SessionFilters {
  from?: string
  to?: string
  model?: string
  tool?: string
  runId?: string
}

interface Metrics {
  sessions: number
  requests: number
  errors: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
}

function emptyMetrics(): Metrics {
  return { sessions: 0, requests: 0, errors: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0 }
}

function addEntry(metrics: Metrics, entry: SessionEntry): void {
  metrics.requests += 1
  metrics.errors += entry.error ? 1 : 0
  metrics.durationMs += entry.durationMs
  metrics.inputTokens += entry.inputTokens
  metrics.outputTokens += entry.outputTokens
  metrics.totalTokens += entry.totalTokens
  metrics.toolCalls += entry.tools?.length ?? 0
}

export function analyzeSessions(sessions: SessionLog[], groupBy: SessionGroupBy, filters: SessionFilters = {}) {
  const totals = emptyMetrics()
  const groups = new Map<string, { metrics: Metrics; sessionIds: Set<string> }>()
  const allSessionIds = new Set<string>()

  for (const session of sessions) {
    if (filters.runId && session.runId !== filters.runId) continue
    for (const entry of session.requests) {
      const day = entry.startedAt.slice(0, 10)
      if (filters.from && day < filters.from) continue
      if (filters.to && day > filters.to) continue
      if (filters.model && entry.model !== filters.model) continue
      if (filters.tool && !entry.tools?.includes(filters.tool)) continue

      allSessionIds.add(session.runId)
      addEntry(totals, entry)
      const keys = groupBy === 'day' ? [day]
        : groupBy === 'model' ? [entry.model ?? '(unknown)']
          : groupBy === 'session' ? [session.runId]
            : [...new Set(entry.tools === null ? ['(unknown)'] : entry.tools.length ? entry.tools : ['(none)'])]
      for (const key of keys) {
        let group = groups.get(key)
        if (!group) {
          group = { metrics: emptyMetrics(), sessionIds: new Set() }
          groups.set(key, group)
        }
        group.sessionIds.add(session.runId)
        addEntry(group.metrics, entry)
        if (groupBy === 'tool') {
          group.metrics.toolCalls -= entry.tools?.length ?? 0
          group.metrics.toolCalls += entry.tools?.filter(name => name === key).length ?? 0
        }
      }
    }
  }

  totals.sessions = allSessionIds.size
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  return {
    groupBy,
    filters,
    totals,
    truncatedGroups: sortedGroups.length > MAX_GROUPS,
    groups: sortedGroups.slice(0, MAX_GROUPS).map(([key, group]) => ({
      key,
      ...group.metrics,
      sessions: group.sessionIds.size,
    })),
  }
}
