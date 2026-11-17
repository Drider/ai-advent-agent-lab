import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MemoryError } from './errors'
import { createMemoryUsageRepository } from './usage-repository'
import type { HistoryClearResult } from '../../shared/memory'

interface OperationRow {
  id: string
  session_id: string
  old_run_log_id: string
  new_run_log_id: string
  status: 'pending_files' | 'completed' | 'failed'
  error: string | null
  started_at: string
  finished_at: string | null
}

function toResult(row: OperationRow): HistoryClearResult & { oldRunLogId: string; newRunLogId: string } {
  return {
    operationId: row.id,
    sessionId: row.session_id,
    oldRunLogId: row.old_run_log_id,
    newRunLogId: row.new_run_log_id,
    status: row.status,
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  }
}

function nextRunLogId(db: Database.Database): string {
  let timestamp = Date.now()
  const isReserved = db.prepare(`
    SELECT 1 FROM sessions WHERE run_log_id = ?
    UNION ALL SELECT 1 FROM history_clear_operations WHERE old_run_log_id = ? OR new_run_log_id = ?
    LIMIT 1
  `)
  while (isReserved.get(new Date(timestamp).toISOString(), new Date(timestamp).toISOString(), new Date(timestamp).toISOString())) timestamp += 1
  return new Date(timestamp).toISOString()
}

function findOperation(db: Database.Database, operationId: string): OperationRow | undefined {
  return db.prepare('SELECT * FROM history_clear_operations WHERE id = ?').get(operationId) as OperationRow | undefined
}

export function assertHistoryAvailable(db: Database.Database, sessionId: string): void {
  const session = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)
  if (!session) throw new MemoryError('NOT_FOUND', 'session was not found')
  const pending = db.prepare(`SELECT 1 FROM history_clear_operations WHERE session_id = ? AND status <> 'completed' LIMIT 1`).get(sessionId)
  if (pending) throw new MemoryError('HISTORY_CLEAR_PENDING', 'session history cleanup is pending')
}

export function createHistoryClearRepository(db: Database.Database) {
  function begin(sessionId: string, operationId: string): HistoryClearResult & { oldRunLogId: string; newRunLogId: string } {
    return db.transaction(() => {
      const existing = findOperation(db, operationId)
      if (existing) {
        if (existing.session_id !== sessionId) throw new MemoryError('INVALID_INPUT', 'history cleanup operation belongs to another session')
        return toResult(existing)
      }
      const session = db.prepare('SELECT id, run_log_id, status FROM sessions WHERE id = ?').get(sessionId) as { id: string; run_log_id: string; status: string } | undefined
      if (!session) throw new MemoryError('NOT_FOUND', 'session was not found')
      const other = db.prepare(`SELECT 1 FROM history_clear_operations WHERE session_id = ? AND status <> 'completed' LIMIT 1`).get(sessionId)
      if (other) throw new MemoryError('HISTORY_CLEAR_PENDING', 'session history cleanup is pending')
      if (session.status === 'running' || db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
        throw new MemoryError('SESSION_RUNNING', 'session is running')
      }
      const timestamp = new Date().toISOString()
      const newRunLogId = nextRunLogId(db)

      const requestIds = db.prepare('SELECT request_id FROM turns WHERE session_id = ?').all(sessionId) as Array<{ request_id: string }>
      const insertRequest = db.prepare('INSERT OR IGNORE INTO cleared_requests (request_id, session_id, cleared_at) VALUES (?, ?, ?)')
      for (const request of requestIds) insertRequest.run(request.request_id, sessionId, timestamp)
      const toolCalls = db.prepare(`
        SELECT tool_executions.tool_call_id
        FROM tool_executions JOIN turns ON turns.id = tool_executions.turn_id
        WHERE turns.session_id = ?
      `).all(sessionId) as Array<{ tool_call_id: string }>
      const insertToolCall = db.prepare('INSERT OR IGNORE INTO cleared_tool_calls (tool_call_id, session_id, cleared_at) VALUES (?, ?, ?)')
      for (const toolCall of toolCalls) insertToolCall.run(toolCall.tool_call_id, sessionId, timestamp)

      const sourceMessages = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId) as Array<{ id: string }>
      for (const source of sourceMessages) {
        db.prepare('UPDATE working_memory_entries SET source_message_id = NULL WHERE source_message_id = ?').run(source.id)
        db.prepare('UPDATE long_term_facts SET source_message_id = NULL WHERE source_message_id = ?').run(source.id)
        db.prepare('UPDATE sessions SET branch_source_message_id = NULL WHERE branch_source_message_id = ?').run(source.id)
      }
      db.prepare('DELETE FROM facts_updates WHERE session_id = ?').run(sessionId)
      db.prepare('DELETE FROM context_checkpoints WHERE session_id = ?').run(sessionId)
      db.prepare('DELETE FROM compaction_attempts WHERE session_id = ?').run(sessionId)
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId)
      createMemoryUsageRepository(db).markSessionContextCleared(sessionId)
      db.prepare("UPDATE sessions SET title = 'Новый диалог', status = 'idle', updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, sessionId)
      db.prepare(`
        INSERT INTO history_clear_operations
          (id, session_id, old_run_log_id, new_run_log_id, status, started_at)
        VALUES (?, ?, ?, ?, 'pending_files', ?)
      `).run(operationId, sessionId, session.run_log_id, newRunLogId, timestamp)
      return toResult(findOperation(db, operationId)!)
    }).immediate()
  }

  function pending(): Array<HistoryClearResult & { oldRunLogId: string; newRunLogId: string }> {
    return (db.prepare("SELECT * FROM history_clear_operations WHERE status <> 'completed' ORDER BY started_at ASC, id ASC").all() as OperationRow[]).map(toResult)
  }

  function pendingForSession(sessionId: string): HistoryClearResult | undefined {
    const row = db.prepare("SELECT * FROM history_clear_operations WHERE session_id = ? AND status <> 'completed' ORDER BY started_at DESC, id DESC LIMIT 1").get(sessionId) as OperationRow | undefined
    return row === undefined ? undefined : toResult(row)
  }

  function complete(operationId: string): HistoryClearResult {
    return db.transaction(() => {
      const operation = findOperation(db, operationId)
      if (!operation) throw new MemoryError('NOT_FOUND', 'history cleanup operation was not found')
      if (operation.status === 'completed') return toResult(operation)
      const timestamp = new Date().toISOString()
      db.prepare('UPDATE sessions SET run_log_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').run(operation.new_run_log_id, timestamp, operation.session_id)
      db.prepare("UPDATE history_clear_operations SET status = 'completed', error = NULL, finished_at = ? WHERE id = ?").run(timestamp, operationId)
      return toResult(findOperation(db, operationId)!)
    }).immediate()
  }

  function fail(operationId: string, safeError: string): HistoryClearResult {
    const operation = findOperation(db, operationId)
    if (!operation) throw new MemoryError('NOT_FOUND', 'history cleanup operation was not found')
    if (operation.status === 'completed') return toResult(operation)
    const timestamp = new Date().toISOString()
    db.prepare("UPDATE history_clear_operations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(safeError.slice(0, 500), timestamp, operationId)
    return toResult(findOperation(db, operationId)!)
  }

  return { begin, pending, pendingForSession, complete, fail }
}

