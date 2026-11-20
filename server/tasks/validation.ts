import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { threadId } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import type { ArtifactRef, JsonValue, TaskActorContext, TaskArtifact, TaskCommandEnvelope, TaskCommandResult, TaskSnapshot, ValidationResult } from '../../shared/task'
import type { CheckDefinition, WorkflowDefinition } from '../../shared/workflow'
import { assertJsonValue, canonicalJson } from '../workflows/schema'
import { createFileWorkspace } from '../tools/files/file-workspace'
import { createArtifactStore } from './artifacts'
import { checkOptions, evaluateCheck, property, successfulOutput, type ToolReceipt } from './checks'
import { TaskError } from './errors'

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
const active = new Set<string>()

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
  const request = db.prepare<[string], { token: string; pid: number; thread: number }>(`
    SELECT id AS token, json_extract(details_json, '$.pid') AS pid, json_extract(details_json, '$.thread') AS thread FROM task_events
    WHERE operation_id = ? AND type = 'validation_requested'
  `)
  // Only an identical replay may reclaim an abandoned read-only validation.
  function reclaim(operationId: string) {
    const owner = request.get(operationId)
    if (!owner) return false
    if (owner.pid === process.pid) {
      if (owner.thread !== threadId || active.has(owner.token)) return false
    } else {
      try { process.kill(owner.pid, 0); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
      }
    }
    db.prepare("DELETE FROM task_commands WHERE operation_id = ? AND phase = 'running'").run(operationId)
    return true
  }

  function reserve(task: TaskSnapshot, definition: WorkflowDefinition, checkIds: string[], actor: TaskActorContext,
    operationId: string, inputHash: string, timestamp: string): ValidationRun {
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
    const token = randomUUID()
    db.prepare(`INSERT INTO task_commands (operation_id, session_id, task_id, actor, input_hash, phase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(operationId, task.sessionId, task.id, actor.role, inputHash, timestamp, timestamp)
    const details = { pid: process.pid, thread: threadId, nodeVisitId: task.nodeVisitId, checks: checks.map(({ check, inputs }) => ({ id: check.id, inputs })) }
    db.prepare(`INSERT INTO task_events (id, session_id, task_id, operation_id, source_turn_id, actor, type, phase,
      revision, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, 'validation_requested', 'completed', ?, ?, ?)`)
      .run(token, task.sessionId, task.id, operationId, actor.turnId ?? null, actor.role, task.revision, JSON.stringify(details), timestamp)
    return { token, task, checks }
  }

  function verify(run: ValidationRun, operationId: string, current: TaskSnapshot) {
    if (request.get(operationId)?.token !== run.token) throw new TaskError('OPERATION_CONFLICT', 'Validation reservation changed')
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
  return { reserve, verify, persist, reclaim }
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

export async function executeTaskCommand(runtime: CommandRuntime, taskId: string, envelope: TaskCommandEnvelope,
  actor: TaskActorContext): Promise<TaskCommandResult> {
  const run = runtime.transaction(taskId, envelope, actor)
  if ('ok' in run) return run
  const { now, readTextFile } = runtime
  active.add(run.token)
  try {
    const read = readTextFile ?? createValidationFileReader()
    const results = await Promise.all(run.checks.map(async ({ check, artifacts, inputs, toolResults }): Promise<ValidationResult> => ({
      id: randomUUID(), taskId: run.task.id, checkId: check.id, checkerVersion: 1, nodeVisitId: run.task.nodeVisitId!, inputs,
      ...await evaluateCheck(check, artifacts, { toolResults, readTextFile: read }), createdAt: now(),
    })))
    const final = runtime.transaction(taskId, envelope, actor, { run, results })
    if (!('ok' in final)) throw new Error('Unexpected second validation reservation')
    return final
  } finally {
    active.delete(run.token)
  }
}
