import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LanguageModelUsage } from 'ai'

export type RunLogLevel = 'off' | 'basic' | 'detailed' | 'raw'
export type RunLogStatus = 'completed' | 'failed' | 'aborted' | 'unknown' | 'empty_response' | 'step_limit'

export interface RunLogRequest {
  model?: string
  messages?: unknown[]
  instructions?: unknown
}

export interface RunLogResponse {
  finishReason?: string
  rawFinishReason?: string
  id?: string
  modelId?: string
  headers?: unknown
  timestamp?: unknown
}

export interface RunLogEntry {
  runId: string
  level: RunLogLevel
  question: string
  answer?: string
  error?: string
  status?: RunLogStatus
  sessionId?: string
  turnId?: string
  errorDetails?: unknown
  diagnostics?: Record<string, unknown>
  /** Values to redact from every string; never written to the log. */
  sensitiveValues?: readonly string[]
  startedAt: string
  completedAt: string
  durationMs: number
  usage?: LanguageModelUsage
  request?: RunLogRequest
  response?: RunLogResponse
  steps?: unknown[]
  rawResponse?: unknown[]
}

interface StoredRunLog {
  runId: string
  startedAt: string
  updatedAt: string
  level: Exclude<RunLogLevel, 'off'>
  requests: Array<Record<string, unknown>>
}

const ISO_RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const pendingWrites = new Map<string, Promise<void>>()
let temporaryFileCounter = 0

function normalizeRunId(runId: string): string {
  return ISO_RUN_ID_PATTERN.test(runId) ? runId : new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function redactString(value: string, sensitiveValues: readonly string[]): string {
  for (const secret of sensitiveValues) {
    if (secret) value = value.replaceAll(secret, '[REDACTED]')
  }
  return value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(
    /([?&](?:api[_-]?key|access[_-]?token|authorization|token)=)[^&\s]+/gi,
    '$1[REDACTED]',
  )
}

function redactSecrets(value: unknown, ancestors = new WeakSet<object>(), sensitiveValues: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    // API error bodies are often JSON encoded inside a string.
    if (/^\s*[\[{]/u.test(value)) {
      try {
        const parsed = JSON.parse(value)
        const redacted = JSON.stringify(redactSecrets(parsed, ancestors, sensitiveValues))
        return redacted === JSON.stringify(parsed) ? value : redacted
      } catch { /* Keep non-JSON provider messages as text. */ }
    }
    return redactString(value, sensitiveValues)
  }

  if (!isRecord(value)) {
    return typeof value === 'bigint' ? value.toString() : value
  }

  if (ancestors.has(value)) return '[Circular]'
  ancestors.add(value)
  try {
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map(item => redactSecrets(item, ancestors, sensitiveValues))

    // Error.message/stack/cause are not enumerable; omit request bodies and credentials.
    const entries = value instanceof Error
      ? ['name', 'message', 'code', 'statusCode', 'isRetryable', 'url', 'responseHeaders',
          'responseBody', 'data', 'cause', 'errors', 'lastError', 'reason', 'stack']
        .filter(key => key in value)
        .map(key => [key, value[key]] as const)
      : Object.entries(value)
    const result: Record<string, unknown> = {}
    for (const [key, item] of entries) {
      result[key] = /^(?:x[-_]?)?api[-_]?key$|^(?:proxy[-_]?)?authorization$|^(?:access[-_]?|refresh[-_]?)?token$|^(?:client[-_]?)?secret$|^password$|^(?:set[-_]?)?cookie$/iu.test(key)
        ? '[REDACTED]'
        : redactSecrets(item, ancestors, sensitiveValues)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function projectRequest(request: RunLogRequest | undefined): unknown {
  if (!request) {
    return undefined
  }

  return {
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.messages === undefined ? {} : { messages: request.messages }),
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
  }
}

function projectResponse(response: RunLogResponse | undefined): unknown {
  if (!response) {
    return undefined
  }

  return {
    ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
    ...(response.rawFinishReason === undefined ? {} : { rawFinishReason: response.rawFinishReason }),
    ...(response.id === undefined ? {} : { id: response.id }),
    ...(response.modelId === undefined ? {} : { modelId: response.modelId }),
    ...(response.headers === undefined ? {} : { headers: response.headers }),
    ...(response.timestamp === undefined ? {} : { timestamp: response.timestamp }),
  }
}

function projectStep(step: unknown): unknown {
  if (!isRecord(step)) {
    return step
  }

  const projected = {
    ...(typeof step.stepNumber === 'number' ? { stepNumber: step.stepNumber } : {}),
    ...(typeof step.text === 'string' ? { text: step.text } : {}),
    ...(step.model === undefined ? {} : { model: step.model }),
    ...(step.toolCalls === undefined ? {} : { toolCalls: step.toolCalls }),
    ...(step.toolResults === undefined ? {} : { toolResults: step.toolResults }),
    ...(step.finishReason === undefined ? {} : { finishReason: step.finishReason }),
    ...(step.rawFinishReason === undefined ? {} : { rawFinishReason: step.rawFinishReason }),
    ...(step.usage === undefined ? {} : { usage: step.usage }),
    ...(step.warnings === undefined ? {} : { warnings: step.warnings }),
    ...(step.response === undefined ? {} : { response: projectResponse(step.response as RunLogResponse) }),
    ...(step.providerMetadata === undefined ? {} : { providerMetadata: step.providerMetadata }),
  }

  return projected
}

function projectEntry(entry: RunLogEntry): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    question: entry.question,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    durationMs: entry.durationMs,
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
    ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
  }

  if (entry.answer !== undefined) {
    projected.answer = entry.answer
  }

  if (entry.error !== undefined) {
    projected.error = entry.error
  }

  if (entry.usage !== undefined) {
    projected.usage = entry.usage
  }

  if (entry.level === 'detailed' || entry.level === 'raw') {
    if (entry.errorDetails !== undefined) projected.errorDetails = entry.errorDetails
    if (entry.diagnostics !== undefined) projected.diagnostics = entry.diagnostics
    const request = projectRequest(entry.request)
    const response = projectResponse(entry.response)
    if (request !== undefined) {
      projected.request = request
    }
    if (response !== undefined) {
      projected.response = response
    }
    if (entry.steps !== undefined) {
      projected.steps = entry.steps.map(step => projectStep(step))
    }
  }

  if (entry.level === 'raw' && entry.rawResponse !== undefined) {
    projected.rawResponse = entry.rawResponse
  }

  return redactSecrets(projected, new WeakSet<object>(), entry.sensitiveValues) as Record<string, unknown>
}

async function readStoredRunLog(filePath: string): Promise<StoredRunLog | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as StoredRunLog
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/** Appends one diagnostic entry to the current session's JSON log. */
export async function appendRunLogEntry(
  entry: RunLogEntry,
  directory = join(process.cwd(), 'data', 'runs'),
): Promise<void> {
  const level = entry.level
  if (level === 'off') {
    return
  }

  const runId = normalizeRunId(entry.runId)
  const filePath = join(directory, `run-${runId}.json`)
  const previousWrite = pendingWrites.get(filePath) ?? Promise.resolve()
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(async () => {
      await mkdir(directory, { recursive: true })
      const existing = await readStoredRunLog(filePath)
      const log: StoredRunLog = existing ?? {
        runId,
        startedAt: entry.startedAt,
        updatedAt: entry.completedAt,
        level,
        requests: [],
      }

      log.updatedAt = entry.completedAt
      log.level = level
      log.requests.push(projectEntry(entry))

      const temporaryPath = `${filePath}.${process.pid}.${temporaryFileCounter++}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(log, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, filePath)
    })

  pendingWrites.set(filePath, nextWrite)

  try {
    await nextWrite
  } finally {
    if (pendingWrites.get(filePath) === nextWrite) {
      pendingWrites.delete(filePath)
    }
  }
}
