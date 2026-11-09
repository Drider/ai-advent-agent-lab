import { tool } from 'ai'
import { z } from 'zod'
import type { RunLogLevel } from '../../utils/run-logger'
import { analyzeSessions, type SessionLog } from './session-analysis'
import { createSessionStore, type SessionStoreOptions } from './session-store'

const sessionPath = z.string().min(1).max(512)
const MAX_ENTRY_TEXT = 1000
const MAX_METADATA_VALUES = 50
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

interface CurrentSessionContext {
  runId: string
  modelId: string
  logLevel: RunLogLevel
  currentQuestion: string
}

export interface SessionToolsOptions extends SessionStoreOptions {
  currentSession?: CurrentSessionContext
}

function excerpt(text: string | undefined): string | undefined {
  return text === undefined ? undefined : text.slice(0, MAX_ENTRY_TEXT)
}

function sessionPage(session: SessionLog, path: string, query: string | undefined, offset: number, limit: number) {
  const matching = session.requests.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !query || `${entry.question}\n${entry.answer ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return {
    path,
    runId: session.runId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    level: session.level,
    totalRequests: session.requests.length,
    matchingRequests: matching.length,
    offset,
    hasMore: offset + limit < matching.length,
    entries: matching.slice(offset, offset + limit).map(({ entry, index }) => ({
      index,
      question: excerpt(entry.question),
      answer: excerpt(entry.answer),
      error: excerpt(entry.error),
      startedAt: entry.startedAt,
      durationMs: entry.durationMs,
      model: entry.model,
      tools: entry.tools?.slice(0, MAX_METADATA_VALUES),
      toolsTruncated: (entry.tools?.length ?? 0) > MAX_METADATA_VALUES,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      questionTruncated: entry.question.length > MAX_ENTRY_TEXT,
      answerTruncated: (entry.answer?.length ?? 0) > MAX_ENTRY_TEXT,
      errorTruncated: (entry.error?.length ?? 0) > MAX_ENTRY_TEXT,
    })),
  }
}

export function createSessionTools(options: SessionToolsOptions = {}) {
  const store = createSessionStore(options)
  return {
    get_current_session: tool({
      description: 'Get the exact active chat session ID, model, logging level, log path, and already saved requests. The request currently being answered is not yet saved. Use this for questions about this or the current session; never guess the current session from the newest file.',
      inputSchema: z.object({
        query: z.string().min(1).max(200).optional().describe('Optional case-insensitive search in saved questions and answers'),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(10).default(10),
      }),
      execute: async ({ query, offset, limit }) => {
        const current = options.currentSession
        if (!current || !RUN_ID_PATTERN.test(current.runId)) {
          return { ok: false as const, error: { code: 'UNAVAILABLE', message: 'current session context is unavailable' } }
        }
        const path = `runs/run-${current.runId}.json`
        const result = await store.readSessionFile(path)
        const context = {
          runId: current.runId,
          path,
          modelId: current.modelId,
          logLevel: current.logLevel,
          currentQuestion: excerpt(current.currentQuestion),
          currentQuestionTruncated: current.currentQuestion.length > MAX_ENTRY_TEXT,
          currentRequestPersisted: false,
        }
        if (!result.ok) {
          if (result.error.code === 'NOT_FOUND') {
            return {
              ok: true as const,
              data: { ...context, saved: false, savedRequests: 0, matchingRequests: 0, offset, hasMore: false, entries: [] },
            }
          }
          return { ok: false as const, error: result.error, context }
        }
        if (result.data.session.runId !== current.runId) {
          return { ok: false as const, error: { code: 'INVALID_INPUT', message: 'session log ID does not match the active session' }, context }
        }
        const page = sessionPage(result.data.session, path, query, offset, limit)
        return {
          ok: true as const,
          data: {
            ...context,
            ...page,
            saved: true,
            savedRequests: result.data.session.requests.length,
            totals: analyzeSessions([result.data.session], 'session').totals,
          },
        }
      },
    }),
    list_sessions: tool({
      description: 'List available JSON session logs in the standard log directories. Returns paths for read_session_file, run IDs, dates, levels, request counts, models, and tools.',
      inputSchema: z.object({}),
      execute: async () => {
        const { sessions, skippedFiles, truncated } = await store.loadSessions()
        return {
          sessions: sessions.map((session) => {
            const models = [...new Set(session.requests.map(entry => entry.model).filter((value): value is string => value !== null))]
            const tools = [...new Set(session.requests.flatMap(entry => entry.tools ?? []))]
            return {
              runId: session.runId,
              path: session.path,
              source: session.source,
              startedAt: session.startedAt,
              updatedAt: session.updatedAt,
              level: session.level,
              requests: session.requests.length,
              models: models.slice(0, MAX_METADATA_VALUES),
              modelsTruncated: models.length > MAX_METADATA_VALUES,
              tools: tools.slice(0, MAX_METADATA_VALUES),
              toolsTruncated: tools.length > MAX_METADATA_VALUES,
            }
          }),
          skippedFiles,
          truncated,
        }
      },
    }),
    read_session_file: tool({
      description: 'Read and parse a specific JSON session log found with find_files. The path is relative to the data workspace. Returns session metadata and a bounded page of requests with question, answer, model, tools, duration, and tokens. Use query to find requests by question or answer text.',
      inputSchema: z.object({
        path: sessionPath.describe('Relative path returned by find_files, for example runs/run-2026-11-09T12:00:00.000Z.json'),
        query: z.string().min(1).max(200).optional().describe('Optional case-insensitive text search in questions and answers'),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(10).default(10),
      }),
      execute: async ({ path, query, offset, limit }) => {
        const result = await store.readSessionFile(path)
        if (!result.ok) return result
        return {
          ok: true as const,
          data: sessionPage(result.data.session, result.data.path, query, offset, limit),
        }
      },
    }),
    analyze_sessions: tool({
      description: 'Aggregate session requests by UTC day, model, tool, or session. Pass paths found with find_files to analyze specific files, or omit paths to scan the default log directories. Optional inclusive UTC date, model, tool, and run ID filters. Returns counts, duration, token usage, and tool-call counts. Basic logs lack model/tool details.',
      inputSchema: z.object({
        groupBy: z.enum(['day', 'model', 'tool', 'session']),
        paths: z.array(sessionPath).min(1).max(20).optional().describe('Optional relative JSON file paths returned by find_files'),
        from: z.iso.date().optional().describe('Inclusive UTC start date YYYY-MM-DD'),
        to: z.iso.date().optional().describe('Inclusive UTC end date YYYY-MM-DD'),
        model: z.string().min(1).max(200).optional(),
        tool: z.string().min(1).max(100).optional(),
        runId: z.iso.datetime({ offset: true }).optional(),
      }),
      execute: async ({ groupBy, paths, from, to, model, tool, runId }) => {
        const fileErrors: Array<{ path: string; code: string; message: string }> = []
        let sessions
        let skippedFiles
        let truncated
        if (paths) {
          const selected = new Map<string, Awaited<ReturnType<typeof store.readSessionFile>> & { ok: true }>()
          for (const path of [...new Set(paths)]) {
            const result = await store.readSessionFile(path)
            if (!result.ok) {
              fileErrors.push({ path, ...result.error })
              continue
            }
            const previous = selected.get(result.data.session.runId)
            if (!previous || result.data.session.updatedAt >= previous.data.session.updatedAt) {
              selected.set(result.data.session.runId, result)
            }
          }
          sessions = [...selected.values()].map(result => result.data.session)
          skippedFiles = fileErrors.length
          truncated = false
        } else {
          ({ sessions, skippedFiles, truncated } = await store.loadSessions())
        }
        return {
          ...analyzeSessions(sessions, groupBy, { from, to, model, tool, runId }),
          skippedFiles,
          truncated,
          fileErrors,
        }
      },
    }),
  }
}

export type SessionTools = ReturnType<typeof createSessionTools>
