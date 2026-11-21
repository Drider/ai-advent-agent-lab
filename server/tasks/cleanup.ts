import type Database from 'better-sqlite3'
import { MemoryError } from '../memory/errors'

function assertSessionExists(db: Database.Database, sessionId: string): void {
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
    throw new MemoryError('NOT_FOUND', 'session was not found')
  }
}

/** Ensure no turn, command, tool operation, or recovery review can still write task evidence. */
export function assertTaskSessionQuiescent(db: Database.Database, sessionId: string): void {
  assertSessionExists(db, sessionId)

  if (db.prepare(`
    SELECT 1 FROM history_clear_operations
    WHERE session_id = ? AND status <> 'completed'
    LIMIT 1
  `).get(sessionId)) {
    throw new MemoryError('HISTORY_CLEAR_PENDING', 'session history cleanup is pending')
  }

  if (db.prepare(`
    SELECT 1 FROM sessions
    WHERE id = ? AND status = 'running'
    UNION ALL
    SELECT 1 FROM turns
    WHERE session_id = ? AND status = 'running'
    LIMIT 1
  `).get(sessionId, sessionId)) {
    throw new MemoryError('SESSION_RUNNING', 'session is running')
  }

  if (db.prepare(`
    SELECT 1
    FROM task_commands
    WHERE session_id = ? AND phase = 'running'
    UNION ALL
    SELECT 1
    FROM task_tool_operations operation
    JOIN tasks task ON task.id = operation.task_id
    WHERE task.session_id = ? AND operation.status IN ('running', 'uncertain')
    UNION ALL
    SELECT 1
    FROM tasks
    WHERE session_id = ? AND recovery = 'needs_review'
    LIMIT 1
  `).get(sessionId, sessionId, sessionId)) {
    throw new MemoryError('SESSION_RUNNING', 'task operations still require completion or recovery review')
  }
}

/** Remove dialogue-owned task state while preserving project memory and files. */
export function clearSessionTaskData(db: Database.Database, sessionId: string): void {
  assertTaskSessionQuiescent(db, sessionId)
  const clearedAt = new Date().toISOString()
  const requests = db.prepare(`
    SELECT operation_id AS requestId,
           json_extract(receipt_json, '$.resumeRequestId') AS resumeRequestId
    FROM task_commands
    WHERE session_id = ?
  `).all(sessionId) as Array<{ requestId: string; resumeRequestId: string | null }>
  const tombstone = db.prepare(`
    INSERT OR IGNORE INTO cleared_requests (request_id, session_id, cleared_at)
    VALUES (?, ?, ?)
  `)
  for (const request of requests) {
    tombstone.run(request.requestId, sessionId, clearedAt)
    if (request.resumeRequestId !== null) tombstone.run(request.resumeRequestId, sessionId, clearedAt)
  }

  // Task-owned rows cascade from tasks. Taskless commands/events remain
  // dialogue-owned and must be removed explicitly after their dependants.
  db.prepare('DELETE FROM tasks WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM task_events WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM task_commands WHERE session_id = ?').run(sessionId)
}
