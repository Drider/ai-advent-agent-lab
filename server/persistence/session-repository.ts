import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { validateUIMessages } from 'ai'
import { classifyAgentStopReason } from '../utils/agent-stop-reason'
import { createTurnRepository } from './turn-repository'
import { createFactsRepository } from '../context-compaction/facts-repository'
import { createTaskService } from '../tasks/commands'
import { createTaskRepository } from '../tasks/repository'
import { MemoryError } from '../memory/errors'
import { assertHistoryAvailable } from '../memory/clear-repository'
import { createUserProfileRepository } from './user-profile-repository'
import {
  CHAT_MESSAGE_STORAGE_VERSION,
  DEFAULT_CONTEXT_STRATEGY_SETTINGS,
  validateContextStrategySettings,
  validateModelId,
  type CompactionAttemptView,
  type ChatMessageStatus,
  type ChatStopReason,
  type ChatSessionStatus,
  type ChatContextStrategySettings,
  type ChatUIMessage,
  type SessionDetail,
  type SessionBranchLink,
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
  context_strategy_json: string
  parent_session_id: string | null
  branch_source_message_id: string | null
  project_id: string | null
  user_profile_id: string
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

interface CompactionAttemptRow {
  id: string
  session_id: string
  turn_id: string
  user_message_id: string | null
  trigger: CompactionAttemptView['trigger']
  status: CompactionAttemptView['status']
  model_id: string
  from_message_position: number
  through_message_position: number
  estimated_before_tokens: number
  estimated_after_tokens: number
  usage_json: string | null
  cost_json: string | null
  summary: string | null
  error: string | null
  started_at: string
  finished_at: string | null
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
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    ...(row.branch_source_message_id === null ? {} : { branchSourceMessageId: row.branch_source_message_id }),
  }
}

function toBranchLink(row: { id: string; title: string; branch_source_message_id: string | null; updated_at: string }): SessionBranchLink {
  return {
    id: row.id,
    title: row.title,
    ...(row.branch_source_message_id === null ? {} : { branchSourceMessageId: row.branch_source_message_id }),
    updatedAt: row.updated_at,
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

function decodeOptionalJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : JSON.parse(value) as T
}

function decodeContextStrategy(value: string | null | undefined): ChatContextStrategySettings {
  if (!value) return { ...DEFAULT_CONTEXT_STRATEGY_SETTINGS }
  try {
    return validateContextStrategySettings(JSON.parse(value))
  } catch {
    return { ...DEFAULT_CONTEXT_STRATEGY_SETTINGS }
  }
}

function getCompactionAttempts(db: Database.Database, sessionId: string): CompactionAttemptView[] {
  const rows = db.prepare(`
    SELECT a.id, a.session_id, a.turn_id, a.trigger, a.status, a.model_id,
           a.from_message_position, a.through_message_position,
           a.estimated_before_tokens, a.estimated_after_tokens,
           a.usage_json, a.cost_json, c.summary, a.error, a.started_at,
           a.finished_at, user_message.id AS user_message_id
    FROM compaction_attempts AS a
    LEFT JOIN context_checkpoints AS c ON c.id = a.checkpoint_id
    LEFT JOIN messages AS user_message
      ON user_message.turn_id = a.turn_id AND user_message.role = 'user'
    WHERE a.session_id = ?
    GROUP BY a.id
    ORDER BY a.started_at ASC, a.rowid ASC
  `).all(sessionId) as CompactionAttemptRow[]

  return rows.map(row => {
    const usage = decodeOptionalJson<CompactionAttemptView['usage']>(row.usage_json)
    const costRub = decodeOptionalJson<CompactionAttemptView['costRub']>(row.cost_json)
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      ...(row.user_message_id === null ? {} : { userMessageId: row.user_message_id }),
      trigger: row.trigger,
      status: row.status,
      modelId: row.model_id,
      fromMessagePosition: row.from_message_position,
      throughMessagePosition: row.through_message_position,
      estimatedBeforeTokens: row.estimated_before_tokens,
      estimatedAfterTokens: row.estimated_after_tokens,
      ...(usage === undefined ? {} : { usage }),
      ...(costRub === undefined ? {} : { costRub }),
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.error === null ? {} : { error: row.error }),
      startedAt: row.started_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    }
  })
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
  const createSessionTransaction = db.transaction((options: { projectId?: string } = {}): SessionSummary => {
    if (options.projectId !== undefined && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(options.projectId)) {
      throw new MemoryError('NOT_FOUND', 'project was not found')
    }
    const profileId = createUserProfileRepository(db).getDefaultId()
    const id = randomUUID()
    let timestamp = Date.now()
    let runLogId = new Date(timestamp).toISOString()
    const hasRunLogId = db.prepare(`
      SELECT 1 FROM sessions WHERE run_log_id = ?
      UNION ALL SELECT 1 FROM history_clear_operations WHERE old_run_log_id = ? OR new_run_log_id = ?
      LIMIT 1
    `)

    while (hasRunLogId.get(runLogId, runLogId, runLogId)) {
      timestamp += 1
      runLogId = new Date(timestamp).toISOString()
    }

    db.prepare(`
      INSERT INTO sessions (id, run_log_id, title, created_at, updated_at, last_opened_at, status, revision, project_id, user_profile_id)
      VALUES (?, ?, ?, ?, ?, NULL, 'idle', 0, ?, ?)
    `).run(id, runLogId, 'Новый диалог', runLogId, runLogId, options.projectId ?? null, profileId)
    return {
      id,
      runLogId,
      title: 'Новый диалог',
      createdAt: runLogId,
      updatedAt: runLogId,
      status: 'idle',
      revision: 0,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    }
  })

  function createSession(options: { projectId?: string } = {}): SessionSummary {
    return createSessionTransaction.immediate(options)
  }

  function listSessions(options: { limit?: number; cursor?: string; projectId?: string | null } = {}): {
    items: SessionSummary[]
    nextCursor?: string
    preferredSessionId?: string
  } {
    const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE
    const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), MAX_PAGE_SIZE)
    const decodedCursor = decodeCursor(options.cursor)
    const conditions: string[] = []
    const params: Array<string | number | null> = []
    if (options.projectId === null) conditions.push('project_id IS NULL')
    else if (options.projectId !== undefined) {
      conditions.push('project_id = ?')
      params.push(options.projectId)
    }
    if (decodedCursor) {
      conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
      params.push(decodedCursor.updatedAt, decodedCursor.updatedAt, decodedCursor.id)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db.prepare(`
      SELECT * FROM sessions
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit + 1) as SessionRow[]

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const preferred = db.prepare(`
      SELECT id
      FROM sessions
      ${options.projectId === null ? 'WHERE project_id IS NULL' : options.projectId === undefined ? '' : 'WHERE project_id = ?'}
      ORDER BY
        CASE WHEN last_opened_at IS NULL THEN 1 ELSE 0 END,
        last_opened_at DESC,
        updated_at DESC,
        id DESC
      LIMIT 1
    `).get(...(options.projectId !== undefined && options.projectId !== null ? [options.projectId] : [])) as { id: string } | undefined

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

    const factsRepository = createFactsRepository(db)
    const userProfile = createUserProfileRepository(db).getForSession(id)
    if (!userProfile) throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} has no assigned profile`)
    const parent = row.parent_session_id === null
      ? undefined
      : db.prepare('SELECT id, title, branch_source_message_id, updated_at FROM sessions WHERE id = ?').get(row.parent_session_id) as { id: string; title: string; branch_source_message_id: string | null; updated_at: string } | undefined
    const children = db.prepare(`
      SELECT id, title, branch_source_message_id, updated_at
      FROM sessions
      WHERE parent_session_id = ?
      ORDER BY updated_at DESC, id DESC
    `).all(id) as Array<{ id: string; title: string; branch_source_message_id: string | null; updated_at: string }>
    const taskRepository = createTaskRepository(db)
    const taskHistory = taskRepository.list(id)
    const currentTask = taskRepository.getUnfinished(id)
    const taskView = currentTask
      ? createTaskService(db).view(currentTask.id, id)
      : { task: null, actions: [], approvals: [], validations: [], recoveryOperations: [] }

    return {
      ...toSummary(row, getTitle(db, row.id, row.title)),
      userProfileId: userProfile.id,
      userProfile: {
        id: userProfile.id,
        name: userProfile.name,
        revision: userProfile.revision,
        defaultWorkflowId: userProfile.defaultWorkflowId,
        createdAt: userProfile.createdAt,
        updatedAt: userProfile.updatedAt,
      },
      messages,
      lastTurn,
      modelId: row.model_id,
      contextStrategy: decodeContextStrategy(row.context_strategy_json),
      stickyFacts: factsRepository.latestFacts(id),
      factsUpdates: factsRepository.listFactsUpdates(id),
      ...(parent === undefined ? {} : { parent: toBranchLink(parent) }),
      children: children.map(toBranchLink),
      compactionAttempts: getCompactionAttempts(db, id),
      taskView,
      taskHistory,
    }
  }

  function setModelId(id: string, modelId: string): void {
    const result = db.prepare('UPDATE sessions SET model_id = ? WHERE id = ?')
      .run(validateModelId(modelId), id)
    if (result.changes !== 1) {
      throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} was not found`)
    }
  }

  function getContextStrategySettings(id: string): ChatContextStrategySettings {
    const row = db.prepare('SELECT context_strategy_json FROM sessions WHERE id = ?').get(id) as { context_strategy_json: string } | undefined
    if (!row) throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} was not found`)
    return decodeContextStrategy(row.context_strategy_json)
  }

  function setContextStrategySettings(id: string, settings: ChatContextStrategySettings): void {
    const validated = validateContextStrategySettings(settings)
    const result = db.prepare('UPDATE sessions SET context_strategy_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
      .run(JSON.stringify(validated), new Date().toISOString(), id)
    if (result.changes !== 1) throw new ChatStorageError('SESSION_NOT_FOUND', `session ${id} was not found`)
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
      assertHistoryAvailable(db, id)
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
        OR tool_call_id IN (SELECT tool_call_id FROM cleared_tool_calls WHERE session_id = ?)
      `).run(id, id)
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    }).immediate()
  }

  return { createSession, listSessions, getSession, activateSession, setModelId, getContextStrategySettings, setContextStrategySettings, deleteSession }
}
