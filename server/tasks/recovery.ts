import type Database from 'better-sqlite3'
import type { JsonValue, TaskActorContext } from '../../shared/task'
import { createTurnRepository } from '../persistence/turn-repository'
import { createFileWorkspace } from '../tools/files/file-workspace'
import { TaskError } from './errors'
import { getOperation, saveOperationResult, sha256, type OperationRow } from './tool-operation-store'
import { workingTool } from './tool-registry'

export function recoverTaskOperations(db: Database.Database) {
  return db.transaction(() => {
    const rows = db.prepare<[], OperationRow>("SELECT * FROM task_tool_operations WHERE status = 'running'").all()
    for (const row of rows) {
      const status = workingTool(row.tool_name)?.mutating === false ? 'failed' : 'uncertain'
      saveOperationResult(db, row, status, undefined, 'Server restarted before the result was saved', 'system')
    }
    // A checker or completion can reserve a read-only validation before doing I/O.
    // Its task mutation and final receipt share a transaction, so a pending call
    // has no committed mutation to replay or reconcile.
    const checks = db.prepare<[], { turnId: string; toolCallId: string }>(`
      SELECT turn_id AS turnId, tool_call_id AS toolCallId FROM tool_executions
      WHERE task_id IS NOT NULL AND task_operation_id IS NULL AND status = 'running'
        AND tool_name IN ('run_task_checks', 'finish_task', 'request_task_transition')
    `).all()
    const turns = createTurnRepository(db)
    for (const call of checks) turns.recordToolEnd({ ...call, error: 'Validation interrupted by server restart' })
    return rows.length + checks.length
  }).immediate()
}

function ownedUncertain(db: Database.Database, id: string, actor: TaskActorContext, taskId?: string) {
  if (actor.role !== 'user' || actor.turnId !== undefined) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Recovery requires a user')
  const row = getOperation(db, id)
  if ((taskId !== undefined && taskId !== row.task_id) || !db.prepare('SELECT 1 FROM tasks WHERE id = ? AND session_id = ?').get(row.task_id, actor.sessionId)) {
    throw new TaskError('NOT_FOUND', 'Operation was not found')
  }
  if (row.status !== 'uncertain') throw new TaskError('OPERATION_CONFLICT', 'Operation is not awaiting review')
  return row
}

export interface RecoveryObservation {
  id: string; taskId: string; observedHash: string | null; output?: JsonValue
}

export async function inspectRecovery(db: Database.Database, id: string, actor: TaskActorContext, rootDir?: string, taskId?: string): Promise<RecoveryObservation> {
  const row = ownedUncertain(db, id, actor, taskId)
  const observation: RecoveryObservation = { id, taskId: row.task_id, observedHash: null }
  if (row.tool_name !== 'write_file' || !row.path || !row.expected_hash) return observation
  const file = await createFileWorkspace(rootDir).readFileBytes(row.path)
  if (!file.ok) return observation
  observation.observedHash = sha256(file.data.bytes)
  if (observation.observedHash === row.expected_hash) {
    observation.output = { ok: true, data: { path: file.data.path, bytesWritten: file.data.bytes.length } }
  }
  return observation
}

// A user's account can release the block, but only a byte-verified write yields file-tool evidence.
export function resolveObservation(db: Database.Database, observation: RecoveryObservation, actor: TaskActorContext,
  outcome?: 'completed' | 'failed') {
  const row = ownedUncertain(db, observation.id, actor, observation.taskId)
  db.prepare('UPDATE task_tool_operations SET observed_hash = ? WHERE id = ?').run(observation.observedHash, row.id)
  if (observation.output !== undefined) {
    if (outcome === 'failed') throw new TaskError('OPERATION_CONFLICT', 'File matches the expected write')
    saveOperationResult(db, row, 'completed', observation.output, undefined, 'user', outcome === undefined)
    return true
  }
  if (!outcome) return false
  saveOperationResult(db, row, outcome, { reviewed: true, outcome }, outcome === 'failed' ? 'User confirmed failure' : undefined, 'user', false)
  return true
}
