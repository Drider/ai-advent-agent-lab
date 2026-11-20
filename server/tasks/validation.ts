import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type Database from 'better-sqlite3'
import type { ArtifactRef, JsonValue, TaskActorContext, TaskArtifact, TaskCommandEnvelope, TaskCommandResult, TaskSnapshot, ValidationResult } from '../../shared/task'
import type { CheckDefinition, WorkflowDefinition } from '../../shared/workflow'
import { assertJsonValue, canonicalJson } from '../workflows/schema'
import { createFileWorkspace } from '../tools/files/file-workspace'
import { createArtifactStore } from './artifacts'
import { checkOptions, evaluateCheck, property, successfulOutput, type ToolReceipt } from './checks'
import { TaskError } from './errors'
import { activeValidationRuns, reconcileValidationReceipts, validationAbandoned, validationWorker } from './validation-attempts'

import { createTaskCommandRuntime } from './commands'

interface CheckRun {
  check: CheckDefinition
  artifacts: TaskArtifact[]
  inputs: ArtifactRef[]
  toolResults: ToolReceipt[]
}
export interface ValidationRun {
  token: string
  task: TaskSnapshot
  checks: CheckRun[]
}
const leaseDurationMs = 30_000

export function hasReadSource(content: JsonValue, receipts: ToolReceipt[]) {
  return receipts.some(({ name, output }) => {
    if (name !== 'read_file' || !successfulOutput(name, output)) return false
    const text = property(property(output, 'data'), 'text')
    if (typeof text !== 'string') return false
    try {
      const parsed: unknown = JSON.parse(text)
      assertJsonValue(parsed)
      return canonicalJson(parsed) === canonicalJson(content)
    } catch { return false }
  })
}
function reference({ id, key, type, version, hash }: TaskArtifact): ArtifactRef {
  return { id, key, type, version, hash }
}

export function createValidationStore(db: Database.Database) {
  const artifacts = createArtifactStore(db)
  const request = db.prepare<[string], { token: string; leaseUntil: number | null; worker: string | null; turnId: string | null; abandoned: number | null }>(`
    SELECT e.id AS token, json_extract(e.details_json, '$.leaseUntil') AS leaseUntil, e.source_turn_id AS turnId,
      json_extract(e.details_json, '$.worker') AS worker, json_extract(e.details_json, '$.abandoned') AS abandoned
    FROM task_events e JOIN task_commands c ON c.operation_id = e.operation_id
    WHERE e.operation_id = ? AND e.type = 'validation_requested' AND c.phase = 'running'
  `)
  const lease = db.prepare(`UPDATE task_events SET details_json = json_set(details_json, '$.leaseUntil', ?)
    WHERE id = ? AND type = 'validation_requested' AND json_extract(details_json, '$.abandoned') IS NOT 1 AND EXISTS (
      SELECT 1 FROM task_commands WHERE operation_id = task_events.operation_id AND phase = 'running'
    )`)
  function setLease(token: string, until: number) {
    lease.run(until, token)
  }
  function owns(operationId: string, token: string) {
    const owner = request.get(operationId)
    return owner?.token === token && owner.abandoned !== 1
  }
  // Only an identical replay may reclaim an abandoned read-only validation.
  function reclaim(operationId: string) {
    const owner = request.get(operationId)
    if (!owner || !validationAbandoned(owner.token, owner.worker, owner.leaseUntil)) return false
    if (owner.turnId) reconcileValidationReceipts(db, owner.turnId, { reservationId: owner.token })
    db.prepare("DELETE FROM task_commands WHERE operation_id = ? AND phase = 'running'").run(operationId)
    return true
  }

  function reserve(task: TaskSnapshot, definition: WorkflowDefinition, checkIds: string[], actor: TaskActorContext,
    operationId: string, inputHash: string, timestamp: string, token: string = randomUUID()): ValidationRun {
    const current = artifacts.workflowArtifacts(task.id)
    const checks = checkIds.map(id => {
      const check = definition.checks.find(item => item.id === id)!
      const inputs = check.artifactKeys.flatMap(key => current.filter(item => item.key === key))
      const toolResults = check.kind === 'tool_success' ? inputs.flatMap(item => {
        const visit = artifacts.producingVisit(task.id, item.id)
        if (!visit) return []
        const files = definition.checks.filter(rule => rule.kind === 'file_matches' && rule.artifactKeys.includes(item.key))
        return artifacts.receipts(task.id, visit, item.sourceToolCallIds).filter(receipt => {
          if (receipt.name !== 'write_file') return true
          return files.every(rule => {
            const options = checkOptions.file_matches.safeParse(rule.options)
            if (!options.success) return false
            const { pathField, contentField } = options.data
            const path = pathField.split('.').reduce<JsonValue | undefined>(property, item.content)
            const text = contentField.split('.').reduce<JsonValue | undefined>(property, item.content)
            return typeof path === 'string' && typeof text === 'string' && property(receipt.input, 'path') === path
              && property(receipt.input, 'content') === text && property(property(receipt.output, 'data'), 'path') === path
          })
        }).map(receipt => ({ ...receipt, artifactId: item.id }))
      }) : []
      return { check, artifacts: inputs, inputs: inputs.map(reference), toolResults }
    })
    db.prepare(`INSERT INTO task_commands (operation_id, session_id, task_id, actor, input_hash, phase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(operationId, task.sessionId, task.id, actor.role, inputHash, timestamp, timestamp)
    const details = { worker: validationWorker, leaseUntil: Date.now() + leaseDurationMs, nodeVisitId: task.nodeVisitId, checks: checks.map(({ check, inputs }) => ({ id: check.id, inputs })) }
    db.prepare(`INSERT INTO task_events (id, session_id, task_id, operation_id, source_turn_id, actor, type, phase,
      revision, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 'validation_requested', 'completed', ?, ?, ?)`)
      .run(token, task.sessionId, task.id, operationId, actor.turnId ?? null, actor.role, task.revision, JSON.stringify(details), timestamp)
    return { token, task, checks }
  }

  function verify(run: ValidationRun, current: TaskSnapshot) {
    if (run.task.nodeVisitId !== current.nodeVisitId || run.task.revision !== current.revision
      || !isDeepStrictEqual(run.task.artifacts, current.artifacts)) {
      throw new TaskError('STALE_TASK_REVISION', 'Validation inputs changed')
    }
  }
  function persist(results: ValidationResult[]) {
    const insert = db.prepare(`INSERT INTO task_validations (id, task_id, check_id, checker_version, node_visit_id,
      inputs_json, outcome, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of results) insert.run(row.id, row.taskId, row.checkId, row.checkerVersion, row.nodeVisitId,
      JSON.stringify(row.inputs), row.outcome, JSON.stringify(row.details), row.createdAt)
  }
  return { reserve, verify, persist, reclaim, owns, setLease }
}

type CommandRuntime = ReturnType<typeof createTaskCommandRuntime>

export function runTaskValidation(db: Database.Database, input: {
  taskId: string; checkIds?: string[]; actor: TaskActorContext; operationId: string; expectedRevision: number
}, runtime: CommandRuntime = createTaskCommandRuntime(db)): Promise<TaskCommandResult> {
  const { taskId, checkIds, actor, operationId, expectedRevision } = input
  const command = checkIds === undefined ? { type: 'validate' as const } : { type: 'validate' as const, checkIds }
  return executeTaskCommand(runtime, taskId, { operationId, expectedRevision, command }, actor)
}

export function createValidationFileReader(rootDir?: string) {
  const workspace = createFileWorkspace(rootDir)
  return async (path: string): Promise<string> => {
    const result = await workspace.readFile(path, { preserveBOM: true })
    if (!result.ok) throw new Error(result.error.code)
    return result.data.text
  }
}

export async function executeTaskCommand(runtime: CommandRuntime, taskId: string | null, envelope: TaskCommandEnvelope,
  actor: TaskActorContext, onValidationFailure?: (error: unknown) => void): Promise<TaskCommandResult> {
  const run = runtime.transaction(taskId, envelope, actor)
  if ('ok' in run) return run
  activeValidationRuns.add(run.token)
  const { now, readTextFile } = runtime
  const renewal = setInterval(() => {
    // If SQLite is momentarily unavailable, the next heartbeat can renew.
    // A replacement reservation always takes precedence over this worker.
    try { runtime.setValidationLease(run.token, Date.now() + leaseDurationMs) } catch {}
  }, leaseDurationMs / 3)
  renewal.unref()
  try {
    const read = readTextFile ?? createValidationFileReader()
    const results = await Promise.all(run.checks.map(async ({ check, artifacts, inputs, toolResults }): Promise<ValidationResult> => ({
      id: randomUUID(), taskId: run.task.id, checkId: check.id, checkerVersion: 1, nodeVisitId: run.task.nodeVisitId!, inputs,
      ...await evaluateCheck(check, artifacts, { toolResults, readTextFile: read }), createdAt: now(),
    })))
    const final = runtime.transaction(taskId, envelope, actor, { run, results })
    if (!('ok' in final)) throw new Error('Unexpected second validation reservation')
    return final
  } catch (error) {
    // Permit immediate replay after a failed final commit. If the database is
    // unavailable, the lease expires naturally.
    try { onValidationFailure?.(error) } catch {}
    try { runtime.setValidationLease(run.token, 0) } catch {}
    throw error
  } finally {
    clearInterval(renewal)
    activeValidationRuns.delete(run.token)
  }
}
