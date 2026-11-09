import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LanguageModelUsage } from 'ai'

export type RunLogLevel = 'off' | 'basic' | 'detailed' | 'raw'

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
}

export interface RunLogEntry {
  runId: string
  level: RunLogLevel
  question: string
  answer?: string
  error?: string
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

function redactString(value: string): string {
  return value.replace(
    /([?&](?:api[_-]?key|access[_-]?token|authorization|token)=)[^&\s]+/gi,
    '$1[REDACTED]',
  )
}

function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }

  if (Array.isArray(value)) {
    return value.map(item => redactSecrets(item))
  }

  if (!isRecord(value)) {
    return value
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[_-]?key|authorization|secret|token)$/iu.test(key)) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = redactSecrets(item)
    }
  }

  return result
}

function projectRequest(request: RunLogRequest | undefined): unknown {
  if (!request) {
    return undefined
  }

  return redactSecrets({
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.messages === undefined ? {} : { messages: request.messages }),
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
  })
}

function projectResponse(response: RunLogResponse | undefined): unknown {
  if (!response) {
    return undefined
  }

  return redactSecrets({
    ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
    ...(response.rawFinishReason === undefined ? {} : { rawFinishReason: response.rawFinishReason }),
    ...(response.id === undefined ? {} : { id: response.id }),
    ...(response.modelId === undefined ? {} : { modelId: response.modelId }),
  })
}

function projectStep(step: unknown): unknown {
  if (!isRecord(step)) {
    return redactSecrets(step)
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
  }

  return redactSecrets(projected)
}

function projectEntry(entry: RunLogEntry): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    question: redactSecrets(entry.question),
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
    durationMs: entry.durationMs,
  }

  if (entry.answer !== undefined) {
    projected.answer = redactSecrets(entry.answer)
  }

  if (entry.error !== undefined) {
    projected.error = redactSecrets(entry.error)
  }

  if (entry.usage !== undefined) {
    projected.usage = redactSecrets(entry.usage)
  }

  if (entry.level === 'detailed' || entry.level === 'raw') {
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
    projected.rawResponse = entry.rawResponse.map(chunk => redactSecrets(chunk))
  }

  return projected
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
