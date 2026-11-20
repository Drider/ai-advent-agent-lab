import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { JsonValue, TaskActorContext } from '../../shared/task'
import { createTurnRepository } from '../persistence/turn-repository'
import { assertJsonValue, canonicalJson } from '../workflows/schema'
import { property, successfulOutput } from './checks'
import { TaskError } from './errors'
import { assertTaskToolAllowed } from './tool-policy'
import { workingTool } from './tool-registry'
import { getOperation, saveOperationResult, sha256, type OperationRow } from './tool-operation-store'
import { inspectRecovery, resolveObservation } from './recovery'

export const actionKeyPattern = /^[A-Za-z0-9_.:-]{1,80}$/
interface Reservation {
  taskId: string; toolName: string; nodeVisitId: string | null; actionKey: string; input: JsonValue
  toolCallId: string; turnId: string; actor?: TaskActorContext
}
type Decision = { kind: 'execute'; id: string } | { kind: 'replay'; id: string; output: JsonValue }

export function createTaskToolOperations(db: Database.Database, options: { rootDir?: string } = {}) {
  const turns = createTurnRepository(db)
  const reserve = db.transaction((request: Reservation): Decision => {
    const { taskId, toolName, turnId, nodeVisitId, toolCallId, actionKey, input } = request
    const turn = db.prepare<[string], { session_id: string }>('SELECT session_id FROM turns WHERE id = ?').get(turnId)
    const actor = request.actor ?? { role: 'agent', sessionId: turn?.session_id ?? '', turnId, stepNodeVisitId: nodeVisitId }
    if (actor.turnId !== turnId || actor.stepNodeVisitId !== nodeVisitId) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Prepared actor changed')
    assertTaskToolAllowed(db, { taskId, toolName, actor })
    if (typeof actionKey !== 'string' || !actionKey || (workingTool(toolName)!.mutating && !actionKeyPattern.test(actionKey))) {
      throw new TaskError('INVALID_INPUT', 'A stable ASCII actionKey (1–80 characters) is required')
    }
    assertJsonValue(input)
    const digest = sha256(canonicalJson(input))
    const prior = db.prepare<[string, string | null, string], OperationRow>(
      'SELECT * FROM task_tool_operations WHERE task_id = ? AND node_visit_id IS ? AND action_key = ?',
    ).get(taskId, nodeVisitId, actionKey)
    if (prior && (prior.input_hash !== digest || prior.tool_name !== toolName)) throw new TaskError('OPERATION_CONFLICT', 'Action key has different input')
    if (prior && (prior.receipt_json === null || !['completed', 'failed'].includes(prior.status))) {
      throw new TaskError('OPERATION_CONFLICT', 'Action has no replayable result')
    }
    const id = prior?.id ?? randomUUID()
    if (!prior) {
      const timestamp = new Date().toISOString()
      const path = property(input, 'path')
      const content = property(input, 'content')
      db.prepare(`INSERT INTO task_tool_operations (id, task_id, node_visit_id, action_key, tool_name, input_hash,
        status, source_turn_id, path, expected_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(id, taskId, nodeVisitId, actionKey, toolName, digest, turnId,
          toolName === 'write_file' && typeof path === 'string' ? path : null,
          toolName === 'write_file' && typeof content === 'string' ? sha256(content) : null, timestamp, timestamp)
    }
    const existing = db.prepare<[string, string], { task_operation_id: string | null }>(
      'SELECT task_operation_id FROM tool_executions WHERE turn_id = ? AND tool_call_id = ?',
    ).get(turnId, toolCallId)
    if (existing && existing.task_operation_id !== id) throw new TaskError('OPERATION_CONFLICT', 'Tool call ID already belongs to another action')
    if (!existing && !turns.recordToolStart({ turnId, toolCallId, name: toolName, input, stepIndex: actor.stepIndex ?? 0,
      taskId, taskOperationId: id })) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Turn no longer accepts tools')
    if (!prior) return { kind: 'execute', id }
    const output: JsonValue = JSON.parse(prior.receipt_json!)
    if (!existing) turns.recordToolEnd({ turnId, toolCallId, output })
    return { kind: 'replay', id, output }
  })

  const complete = db.transaction((id: string, output: JsonValue) => {
    const row = getOperation(db, id)
    if (row.status !== 'running') throw new TaskError('OPERATION_CONFLICT', 'Action is already settled')
    const ioError = row.tool_name === 'write_file' && property(property(output, 'error'), 'code') === 'IO_ERROR'
    const status = ioError ? 'uncertain' : successfulOutput(row.tool_name, output) ? 'completed' : 'failed'
    saveOperationResult(db, row, status, output, ioError ? 'File write outcome unknown' : undefined)
  })
  const fail = db.transaction((id: string, error: unknown) => {
    const row = getOperation(db, id)
    if (row.status !== 'running') return
    saveOperationResult(db, row, workingTool(row.tool_name)?.mutating ? 'uncertain' : 'failed', undefined,
      error instanceof Error ? error.message : String(error))
  })
  async function resolve(id: string, actor: TaskActorContext): Promise<void> {
    const observation = await inspectRecovery(db, id, actor, options.rootDir)
    const resolved = db.transaction(() => resolveObservation(db, observation, actor)).immediate()
    if (!resolved) throw new TaskError('RECOVERY_REVIEW_REQUIRED', 'File could not be confirmed')
  }
  return { reserve: reserve.immediate, complete: complete.immediate, fail: fail.immediate, resolve }
}
