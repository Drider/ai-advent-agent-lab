import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { JsonValue, TaskActorContext } from '../../shared/task'
import { createTurnRepository } from '../persistence/turn-repository'
import { TaskError } from './errors'

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

export interface OperationRow {
  id: string; task_id: string; node_visit_id: string | null; source_turn_id: string | null
  tool_name: string; input_hash: string; status: 'running' | 'completed' | 'failed' | 'uncertain'
  path: string | null; expected_hash: string | null; receipt_json: string | null
}
export function getOperation(db: Database.Database, id: string) {
  const row = db.prepare<[string], OperationRow>('SELECT * FROM task_tool_operations WHERE id = ?').get(id)
  if (!row) throw new TaskError('NOT_FOUND', 'Tool operation was not found')
  return row
}

export function saveOperationResult(db: Database.Database, row: OperationRow, status: OperationRow['status'],
  output: JsonValue | undefined, error?: JsonValue, actor: TaskActorContext['role'] = 'agent', bumpRecoveryRevision = true) {
  const timestamp = new Date().toISOString()
  db.prepare('UPDATE task_tool_operations SET status = ?, receipt_json = ?, updated_at = ? WHERE id = ?')
    .run(status, output === undefined ? null : JSON.stringify(output), timestamp, row.id)
  const executions = db.prepare<[string], { turnId: string; toolCallId: string }>(
    "SELECT turn_id AS turnId, tool_call_id AS toolCallId FROM tool_executions WHERE task_operation_id = ? AND status IN ('running', 'failed')",
  ).all(row.id)
  const turns = createTurnRepository(db)
  for (const execution of executions) turns.recordToolEnd({ ...execution, output, error })
  if (status === 'uncertain' || row.status === 'uncertain') {
    const unresolved = db.prepare("SELECT 1 FROM task_tool_operations WHERE task_id = ? AND status = 'uncertain' LIMIT 1").get(row.task_id)
    const recovery = unresolved ? 'needs_review' : 'clear'
    db.prepare('UPDATE tasks SET recovery = ?, updated_at = ?, revision = revision + ? WHERE id = ? AND recovery <> ?')
      .run(recovery, timestamp, Number(bumpRecoveryRevision), row.task_id, recovery)
  }
  db.prepare(`INSERT INTO task_events (id, session_id, task_id, source_turn_id, actor, type, phase, revision, details_json, created_at)
    SELECT ?, session_id, id, ?, ?, ?, 'completed', revision, ?, ? FROM tasks WHERE id = ?`)
    .run(randomUUID(), row.source_turn_id, actor, 'tool_' + status,
      JSON.stringify({ operationId: row.id, toolName: row.tool_name, nodeVisitId: row.node_visit_id }), timestamp, row.task_id)
}
