import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { validateUIMessages } from 'ai'
import { classifyAgentStopReason } from '../utils/agent-stop-reason'
import { createTurnRepository } from './turn-repository'
import {
  CHAT_MESSAGE_STORAGE_VERSION,
  validateModelId,
  type ChatMessageStatus,
  type ChatStopReason,
  type ChatSessionStatus,
  type ChatUIMessage,
  type SessionDetail,
  type SessionSummary,
  type SessionTurnSummary,
} from '../../shared/chat'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100

export class ChatStorageError extends Error {
  constructor(
    public readonly code: 'INVALID_CURSOR' | 'SESSION_NOT_FOUND' | 'SESSION_RUNNING' | 'INVALID_STORED_MESSAGE' | 'UNSUPPORTED_STORAGE_VERSION',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ChatStorageError'
  }
}

interface SessionRow {
  id: string
  run_log_id: string
  title: string
  created_at: string
  updated_at: string
  last_opened_at: string | null
  status: ChatSessionStatus
  revision: number
  model_id: string | null
}

interface MessageRow {
  id: string
  session_id: string
  role: ChatUIMessage['role']
  status: ChatMessageStatus
  payload_json: string
  storage_version: number
}

interface TurnRow {
  id: string
  session_id: string
  request_id: string
  source_turn_id: string | null
  position: number
  status: SessionTurnSummary['status']
  stop_reason: ChatStopReason | null
  model_id: string
  started_at: string
  finished_at: string | null
  updated_at: string
}

function toSummary(row: SessionRow, title = row.title): SessionSummary {
  return {
    id: row.id,
    runLogId: row.run_log_id,
    title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_opened_at === null ? {} : { lastOpenedAt: row.last_opened_at }),
    status: row.status,
    revision: row.revision,
  }
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | undefined {
  if (cursor === undefined) {
    return undefined
  }

  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    const record = typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : undefined
    if (!record || typeof record.updatedAt !== 'string' || typeof record.id !== 'string') {
      throw new Error('invalid cursor shape')
    }
    return { updatedAt: record.updatedAt, id: record.id }
  } catch (error) {
    throw new ChatStorageError('INVALID_CURSOR', 'session cursor is invalid', { cause: error })
  }
}

function getTitle(db: Database.Database, sessionId: string, fallback: string): string {
  const row = db.prepare(`
    SELECT payload_json
    FROM messages
    WHERE session_id = ? AND role = 'user'
    ORDER BY position ASC
    LIMIT 1
  `).get(sessionId) as { payload_json: string } | undefined

  if (!row) {
    return fallback
  }

  try {
    const message = JSON.parse(row.payload_json) as ChatUIMessage
    const text = message.parts
      .filter((part): part is Extract<ChatUIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
      .map(part => part.text)
      .join('')
      .trim()
    return text ? text.slice(0, 60) : fallback
  } catch {
    return fallback
  }
}

function toTurnSummary(row: TurnRow): SessionTurnSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestId: row.request_id,
    ...(row.source_turn_id === null ? {} : { sourceTurnId: row.source_turn_id }),
    position: row.position,
    status: row.status,
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
    modelId: row.model_id,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    updatedAt: row.updated_at,
  }
}

async function legacyStopReason(logDirectory: string, runLogId: string, turn: TurnRow): Promise<ChatStopReason | undefined> {
  if (turn.stop_reason !== null && turn.stop_reason !== 'agent_error') return undefined
  if (!['failed', 'stopped', 'interrupted'].includes(turn.status)) return undefined
  if (turn.status === 'stopped') return 'user_stopped'
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(runLogId)) return undefined

  try {
    const path = join(logDirectory, `run-${runLogId}.json`)
    const log = JSON.parse(await readFile(path, 'utf8')) as { requests?: Array<{ turnId?: string; status?: string; errorDetails?: unknown; error?: string }> }
    const request = log.requests?.find(entry => entry.turnId === turn.id)
    return request?.status === 'aborted' || request?.status === 'failed'
      ? classifyAgentStopReason(request.errorDetails ?? request.error)
      : undefined
  } catch {
    return undefined
  }
}

async function decodeMessage(row: MessageRow): Promise<ChatUIMessage> {
  if (row.storage_version !== CHAT_MESSAGE_STORAGE_VERSION) {
    throw new ChatStorageError(
      'UNSUPPORTED_STORAGE_VERSION',
      `stored message ${row.id} uses unsupported version ${row.storage_version}`,
    )
  }

  try {
    const parsed = JSON.parse(row.payload_json) as unknown
    const [message] = await validateUIMessages<ChatUIMessage>({ messages: [parsed] })
    if (!message || message.id !== row.id || message.role !== row.role) {
      throw new Error('stored message identity does not match its row')
    }
    return message
  } catch (error) {
    if (error instanceof ChatStorageError) {
      throw error
    }
    throw new ChatStorageError('INVALID_STORED_MESSAGE', `stored message ${row.id} is invalid`, { cause: error })
  }
}

export function createSessionRepository(db: Database.Database) {
  const findSession = db.prepare('SELECT * FROM sessions WHERE id = ?')
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, run_log_id, title, created_at, updated_at, last_opened_at, status, revision)
    VALUES (?, ?, ?, ?, ?, NULL, 'idle', 0)
  `)

  function createSession(): SessionSummary {
    const id = randomUUID()
    let timestamp = Date.now()
    let runLogId = new Date(timestamp).toISOString()
    const hasRunLogId = db.prepare('SELECT 1 FROM sessions WHERE run_log_id = ?')

    while (hasRunLogId.get(runLogId)) {
      timestamp += 1
      runLogId = new Date(timestamp).toISOString()
    }

    insertSession.run(id, runLogId, 'Новый диалог', runLogId, runLogId)
    return {
      id,
      runLogId,
      title: 'Новый диалог',
      createdAt: runLogId,
      updatedAt: runLogId,
      status: 'idle',
      revision: 0,
    }
  }

  function listSessions(options: { limit?: number; cursor?: string } = {}): {
    items: SessionSummary[]
    nextCursor?: string
    preferredSessionId?: string
  } {
    const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_PAGE_SIZE)
    const decodedCursor = decodeCursor(options.cursor)
    const rows = (decodedCursor
      ? db.prepare(`
          SELECT * FROM sessions
          WHERE updated_at < ? OR (updated_at = ? AND id < ?)
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(decodedCursor.updatedAt, decodedCursor.updatedAt, decodedCursor.id, limit + 1)
      : db.prepare(`
          SELECT * FROM sessions
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `).all(limit + 1)) as SessionRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const preferred = db.prepare(`
      SELECT id
      FROM sessions
      ORDER BY
        CASE WHEN last_opened_at IS NULL THEN 1 ELSE 0 END,
        last_opened_at DESC,
        updated_at DESC,
        id DESC
      LIMIT 1
    `).get() as { id: string } | undefined

    return {
      items: page.map(row => toSummary(row, getTitle(db, row.id, row.title))),
      ...(hasMore && page.at(-1) ? { nextCursor: encodeCursor(page.at(-1)!.updated_at, page.at(-1)!.id) } : {}),
      ...(preferred === undefined ? {} : { preferredSessionId: preferred.id }),
    }
  }

  async function getSession(
    id: string,
    options: { excludeTrailingInterruptedAssistant?: boolean } = {},
  ): Promise<SessionDetail | null> {
    const row = findSession.get(id) as SessionRow | undefined
    if (!row) {
      return null
    }

    const messageRows = db.prepare(`
      SELECT id, session_id, role, status, payload_json, storage_version
      FROM messages
      WHERE session_id = ?
      ORDER BY position ASC
    `).all(id) as MessageRow[]
    const messages: ChatUIMessage[] = []
    for (const messageRow of messageRows) {
      messages.push(await decodeMessage(messageRow))
    }
    if (
      options.excludeTrailingInterruptedAssistant === true
      && messageRows.at(-1)?.status === 'interrupted'
      && messages.at(-1)?.role === 'assistant'
    ) {
      const preservedToolParts = messages.at(-1)!.parts.filter(part => part.type !== 'text')
      if (preservedToolParts.length === 0) {
        messages.pop()
      } else {
        messages[messages.length - 1] = {
          ...messages.at(-1)!,
          parts: preservedToolParts,
        }
      }
    }

    const turn = db.prepare(`
      SELECT id, session_id, request_id, source_turn_id, position, status, stop_reason, model_id, started_at, finished_at, updated_at
      FROM turns
      WHERE session_id = ?
      ORDER BY position DESC
      LIMIT 1
    `).get(id) as TurnRow | undefined

    const lastTurn = turn === undefined ? null : toTurnSummary(turn)
    if (lastTurn && turn && (!lastTurn.stopReason || lastTurn.stopReason === 'agent_error')) {
      const diagnosticReason = await legacyStopReason(join(dirname(db.name), 'runs'), row.run_log_id, turn)
      if (diagnosticReason && (diagnosticReason !== 'agent_error' || !lastTurn.stopReason)) {
        lastTurn.stopReason = diagnosticReason
      }
    }
    if (lastTurn) lastTurn.continuation = createTurnRepository(db).assessContinuation(lastTurn.id)

    return {
      ...toSummary(row, getTitle(db, row.id, row.title)),
      messages,
      lastTurn,
      modelId: row.model_id,
    }
  }

  function setModelId(id: string, modelId: string): void {
    const result = db.prepare('UPDATE sessions SET model_id = ? WHERE id = ?')
      .run(validateModelId(modelId), id)
    if (result.changes !== 1) {
      throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} was not found`)
    }
  }

  function activateSession(id: string): void {
    const result = db.prepare('UPDATE sessions SET last_opened_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    if (result.changes !== 1) {
      throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} was not found`)
    }
  }

  function deleteSession(id: string): void {
    db.transaction(() => {
      const session = findSession.get(id) as SessionRow | undefined
      if (!session) {
        throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} was not found`)
      }
      if (session.status === 'running' || db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(id)) {
        throw new ChatStorageError('SESSION_RUNNING', `session ${id} is running`)
      }

      db.prepare(`
        DELETE FROM dice_rolls
        WHERE tool_call_id IN (
          SELECT tool_executions.tool_call_id
          FROM tool_executions
          JOIN turns ON turns.id = tool_executions.turn_id
          WHERE turns.session_id = ?
        )
      `).run(id)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    }).immediate()
  }

  return { createSession, listSessions, getSession, activateSession, setModelId, deleteSession }
}
