import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { UIMessage } from 'ai'
import {
  CHAT_MESSAGE_STORAGE_VERSION,
  type ChatMessageStatus,
  type ChatTurnStatus,
  type ChatUIMessage,
  type SessionTurnSummary,
} from '../../shared/chat'

export class TurnRepositoryError extends Error {
  constructor(
    public readonly code:
      | 'TURN_ALREADY_EXISTS'
      | 'SESSION_NOT_FOUND'
      | 'TURN_NOT_FOUND'
      | 'TOOL_NOT_FOUND'
      | 'CONTINUATION_NOT_AVAILABLE'
      | 'CONTINUATION_NEEDS_REVIEW',
    message: string,
  ) {
    super(message)
    this.name = 'TurnRepositoryError'
  }
}

interface TurnRow extends SessionTurnSummary {
  source_turn_id: string | null
}

interface AssistantMessageRow {
  id: string
  position: number
}

function now(): string {
  return new Date().toISOString()
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
    .trim()
}

function toPublicTurn(row: TurnRow): SessionTurnSummary {
  return {
    id: row.id,
    sessionId: row.sessionId,
    requestId: row.requestId,
    ...(row.source_turn_id === null ? {} : { sourceTurnId: row.source_turn_id }),
    position: row.position,
    status: row.status,
    modelId: row.modelId,
    startedAt: row.startedAt,
    ...(row.finishedAt === undefined ? {} : { finishedAt: row.finishedAt }),
    updatedAt: row.updatedAt,
  }
}

export function createTurnRepository(db: Database.Database) {
  const transaction = <T>(callback: () => T): T => {
    const run = db.transaction(callback)
    return run.immediate()
  }

  function assertSession(sessionId: string): void {
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
      throw new TurnRepositoryError('SESSION_NOT_FOUND', `session ${sessionId} was not found`)
    }
  }

  function assertCanStart(sessionId: string, requestId: string): void {
    if (db.prepare('SELECT 1 FROM turns WHERE request_id = ?').get(requestId)) {
      throw new TurnRepositoryError('TURN_ALREADY_EXISTS', `TURN_ALREADY_EXISTS: request ${requestId} already exists`)
    }
    if (db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
      throw new TurnRepositoryError('TURN_ALREADY_EXISTS', `TURN_ALREADY_EXISTS: session ${sessionId} already has a running turn`)
    }
  }

  function nextTurnPosition(sessionId: string): number {
    const row = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next_position FROM turns WHERE session_id = ?')
      .get(sessionId) as { next_position: number }
    return row.next_position
  }

  function nextMessagePosition(sessionId: string): number {
    const row = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next_position FROM messages WHERE session_id = ?')
      .get(sessionId) as { next_position: number }
    return row.next_position
  }

  function touchSession(sessionId: string, status: string, timestamp: string): void {
    db.prepare(`
      UPDATE sessions
      SET status = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(status, timestamp, sessionId)
  }

  function insertTurn(input: {
    sessionId: string
    requestId: string
    sourceTurnId?: string
    modelId: string
    agentConfig: unknown
    status?: ChatTurnStatus
  }): void {
    const timestamp = now()
    db.prepare(`
      INSERT INTO turns
        (id, session_id, request_id, source_turn_id, position, status, model_id, agent_config_json, started_at, finished_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      input.requestId,
      input.sessionId,
      input.requestId,
      input.sourceTurnId ?? null,
      nextTurnPosition(input.sessionId),
      input.status ?? 'running',
      input.modelId,
      JSON.stringify(input.agentConfig ?? {}),
      timestamp,
      timestamp,
    )
  }

  function insertMessage(sessionId: string, turnId: string, message: UIMessage, status: ChatMessageStatus): void {
    const timestamp = now()
    db.prepare(`
      INSERT INTO messages
        (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      sessionId,
      turnId,
      nextMessagePosition(sessionId),
      message.role,
      status,
      JSON.stringify(message),
      CHAT_MESSAGE_STORAGE_VERSION,
      timestamp,
      timestamp,
    )
  }

  function beginUserTurn(input: {
    sessionId: string
    requestId: string
    modelId: string
    message: ChatUIMessage
    agentConfig: unknown
  }): { turnId: string; userMessageId: string } {
    return transaction(() => {
      assertSession(input.sessionId)
      assertCanStart(input.sessionId, input.requestId)
      insertTurn(input)
      insertMessage(input.sessionId, input.requestId, input.message, 'complete')
      const title = messageText(input.message).slice(0, 60)
      const timestamp = now()
      db.prepare(`
        UPDATE sessions
        SET title = CASE WHEN title = 'Новый диалог' AND ? <> '' THEN ? ELSE title END,
            status = 'running', updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(title, title, timestamp, input.sessionId)
      return { turnId: input.requestId, userMessageId: input.message.id }
    })
  }

  function beginContinuation(input: {
    sessionId: string
    requestId: string
    sourceTurnId: string
    modelId: string
    agentConfig: unknown
  }): { turnId: string } {
    return transaction(() => {
      assertSession(input.sessionId)
      assertCanStart(input.sessionId, input.requestId)
      const source = db.prepare('SELECT session_id FROM turns WHERE id = ?').get(input.sourceTurnId) as { session_id: string } | undefined
      if (!source || source.session_id !== input.sessionId) {
        throw new TurnRepositoryError('TURN_NOT_FOUND', `source turn ${input.sourceTurnId} was not found`)
      }
      const continuation = assessContinuation(input.sourceTurnId)
      if (continuation === 'not_available') {
        throw new TurnRepositoryError('CONTINUATION_NOT_AVAILABLE', `turn ${input.sourceTurnId} is not available for continuation`)
      }
      if (continuation === 'needs_review') {
        throw new TurnRepositoryError('CONTINUATION_NEEDS_REVIEW', `turn ${input.sourceTurnId} has an unconfirmed tool result`)
      }
      insertTurn(input)
      touchSession(input.sessionId, 'running', now())
      return { turnId: input.requestId }
    })
  }

  function getTurnRow(turnId: string): { session_id: string; status: ChatTurnStatus } {
    const row = db.prepare('SELECT session_id, status FROM turns WHERE id = ?').get(turnId) as { session_id: string; status: ChatTurnStatus } | undefined
    if (!row) {
      throw new TurnRepositoryError('TURN_NOT_FOUND', `turn ${turnId} was not found`)
    }
    return row
  }

  function assessContinuation(sourceTurnId: string): 'safe' | 'needs_review' | 'not_available' {
    const turn = db.prepare('SELECT status FROM turns WHERE id = ?').get(sourceTurnId) as { status: ChatTurnStatus } | undefined
    if (!turn || !['interrupted', 'failed', 'stopped', 'needs_review'].includes(turn.status)) {
      return 'not_available'
    }
    if (turn.status === 'needs_review') {
      return 'needs_review'
    }
    const uncertain = db.prepare(`
      SELECT 1
      FROM tool_executions
      WHERE turn_id = ?
        AND (status = 'running' OR (status = 'failed' AND tool_name IN ('rollDie', 'write_file')))
      LIMIT 1
    `).get(sourceTurnId)
    return uncertain ? 'needs_review' : 'safe'
  }

  function saveAssistantSnapshotInTransaction(input: {
    turnId: string
    message: ChatUIMessage
    status: ChatMessageStatus
  }): void {
    transaction(() => {
      const turn = getTurnRow(input.turnId)
      const timestamp = now()
      const existing = db.prepare(`
        SELECT id, position
        FROM messages
        WHERE turn_id = ? AND role = 'assistant'
        ORDER BY position DESC
        LIMIT 1
      `).get(input.turnId) as AssistantMessageRow | undefined

      if (existing) {
        db.prepare(`
          UPDATE messages
          SET status = ?, payload_json = ?, storage_version = ?, updated_at = ?
          WHERE id = ?
        `).run(input.status, JSON.stringify({ ...input.message, id: existing.id }), CHAT_MESSAGE_STORAGE_VERSION, timestamp, existing.id)
      } else {
        insertMessage(turn.session_id, input.turnId, input.message, input.status)
      }
      db.prepare('UPDATE turns SET updated_at = ? WHERE id = ?').run(timestamp, input.turnId)
      db.prepare('UPDATE sessions SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(timestamp, turn.session_id)
    })
  }

  function saveAssistantSnapshot(input: {
    turnId: string
    message: ChatUIMessage
    status: ChatMessageStatus
  }): void {
    transaction(() => saveAssistantSnapshotInTransaction(input))
  }

  function recordToolStart(input: {
    turnId: string
    toolCallId: string
    stepIndex: number
    name: string
    input: unknown
  }): void {
    transaction(() => {
      const turn = getTurnRow(input.turnId)
      if (turn.status !== 'running') {
        return
      }
      const existing = db.prepare('SELECT 1 FROM tool_executions WHERE turn_id = ? AND tool_call_id = ?')
        .get(input.turnId, input.toolCallId)
      if (existing) {
        return
      }
      const timestamp = now()
      db.prepare(`
        INSERT INTO tool_executions
          (id, turn_id, step_index, tool_call_id, tool_name, status, input_json, output_json, error_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?)
      `).run(randomUUID(), input.turnId, input.stepIndex, input.toolCallId, input.name, JSON.stringify(input.input), timestamp, timestamp)
    })
  }

  function recordToolEnd(input: {
    turnId: string
    toolCallId: string
    output?: unknown
    error?: unknown
  }): void {
    transaction(() => {
      const turn = getTurnRow(input.turnId)
      const status = input.error === undefined ? 'completed' : 'failed'
      const result = db.prepare(`
        UPDATE tool_executions
        SET status = ?, output_json = ?, error_json = ?, updated_at = ?
        WHERE turn_id = ? AND tool_call_id = ?
      `).run(
        status,
        input.output === undefined ? null : JSON.stringify(input.output),
        input.error === undefined ? null : JSON.stringify(input.error),
        now(),
        input.turnId,
        input.toolCallId,
      )
      if (result.changes !== 1) {
        throw new TurnRepositoryError('TOOL_NOT_FOUND', `tool call ${input.toolCallId} was not found`)
      }
      db.prepare('UPDATE turns SET updated_at = ? WHERE id = ?').run(now(), input.turnId)
      db.prepare('UPDATE sessions SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(now(), turn.session_id)
    })
  }

  function finishTurn(input: {
    turnId: string
    message: ChatUIMessage
    status: ChatTurnStatus
  }): void {
    transaction(() => {
      const turn = getTurnRow(input.turnId)
      if (turn.status === 'stopped') {
        return
      }
      saveAssistantSnapshotInTransaction({
        turnId: input.turnId,
        message: input.message,
        status: input.status === 'completed' ? 'complete' : input.status === 'interrupted' ? 'interrupted' : 'partial',
      })
      const timestamp = now()
      db.prepare(`
        UPDATE turns
        SET status = ?, finished_at = ?, updated_at = ?
        WHERE id = ?
      `).run(input.status, timestamp, timestamp, input.turnId)
      db.prepare(`
        UPDATE sessions
        SET status = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?
      `).run(input.status, timestamp, turn.session_id)
    })
  }

  function getLastTurn(sessionId: string): SessionTurnSummary | null {
    const row = db.prepare(`
      SELECT id, session_id AS sessionId, request_id AS requestId, source_turn_id, position, status,
             model_id AS modelId, started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt
      FROM turns
      WHERE session_id = ?
      ORDER BY position DESC
      LIMIT 1
    `).get(sessionId) as TurnRow | undefined
    return row === undefined ? null : toPublicTurn(row)
  }

  function markStopped(turnId: string): void {
    transaction(() => {
      const turn = getTurnRow(turnId)
      if (turn.status !== 'running') {
        return
      }
      const timestamp = now()
      db.prepare('UPDATE turns SET status = \'stopped\', finished_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, turnId)
      db.prepare('UPDATE messages SET status = \'interrupted\', updated_at = ? WHERE turn_id = ? AND role = \'assistant\' AND status = \'partial\'')
        .run(timestamp, turnId)
      touchSession(turn.session_id, 'stopped', timestamp)
    })
  }

  function markFailed(turnId: string): void {
    transaction(() => {
      const turn = getTurnRow(turnId)
      if (turn.status !== 'running') {
        return
      }
      const timestamp = now()
      db.prepare("UPDATE turns SET status = 'failed', finished_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, turnId)
      touchSession(turn.session_id, 'failed', timestamp)
    })
  }

  function recoverRunningTurns(): number {
    return transaction(() => {
      const rows = db.prepare("SELECT id, session_id FROM turns WHERE status = 'running'").all() as Array<{ id: string; session_id: string }>
      if (rows.length === 0) {
        return 0
      }
      const timestamp = now()
      const updateTurn = db.prepare("UPDATE turns SET status = 'interrupted', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      const updateMessage = db.prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE turn_id = ? AND role = 'assistant' AND status = 'partial'")
      const updateSession = db.prepare("UPDATE sessions SET status = 'interrupted', updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'running'")
      for (const row of rows) {
        updateTurn.run(timestamp, timestamp, row.id)
        updateMessage.run(timestamp, row.id)
        updateSession.run(timestamp, row.session_id)
      }
      return rows.length
    })
  }

  return {
    beginUserTurn,
    beginContinuation,
    assessContinuation,
    saveAssistantSnapshot,
    recordToolStart,
    recordToolEnd,
    finishTurn,
    getLastTurn,
    markStopped,
    markFailed,
    recoverRunningTurns,
  }
}
