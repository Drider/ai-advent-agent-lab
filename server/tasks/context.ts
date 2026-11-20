import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { TaskArtifact, TaskSnapshot } from '../../shared/task'
import type { WorkflowVersion } from '../../shared/workflow'
import { taskInstructions } from '../tools/tasks/instructions'
import { createWorkflowRepository } from '../workflows/repository'
import { canonicalJson } from '../workflows/schema'
import { createApprovalStore } from './approvals'
import { createArtifactStore } from './artifacts'
import { TaskError } from './errors'
import { createTaskRepository } from './repository'

const blockByteLimit = 16_384

function block(value: unknown, label: string) {
  const json = canonicalJson(JSON.parse(JSON.stringify(value))).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  if (Buffer.byteLength(json) > blockByteLimit) throw new TaskError('CONTEXT_LIMIT', label + ' exceeds 16384 bytes')
  return json
}

function currentMaterial(task: TaskSnapshot, pinned: WorkflowVersion | undefined, artifacts: TaskArtifact[]) {
  const definition = pinned?.definition
  const node = definition?.nodes.find(item => item.id === task.nodeId)
  const transitions = definition?.transitions.filter(edge => edge.from === task.nodeId) ?? []
  const keys = new Set(node?.requiredApprovalKeys)
  if (task.expected.artifactKey) keys.add(task.expected.artifactKey)
  if (task.result) keys.add(task.result.key)
  const checks = new Set(node?.checkIds)
  for (const check of definition?.checks ?? []) {
    if (check.artifactKeys.some(key => node?.writableArtifacts.includes(key))) checks.add(check.id)
  }
  for (const edge of transitions) {
    for (const guard of edge.guards) {
      if ('artifactKey' in guard) keys.add(guard.artifactKey)
      else for (const id of guard.checkIds) checks.add(id)
    }
    const target = definition!.nodes.find(candidate => candidate.id === edge.to)!
    if (target.kind === 'validation') for (const id of target.checkIds) checks.add(id)
    if (target.kind === 'success') {
      keys.add(definition!.resultArtifactKey)
      for (const id of definition!.completionCheckIds) checks.add(id)
    }
  }
  const relevantChecks = definition?.checks.filter(check => checks.has(check.id)) ?? []
  for (const check of relevantChecks) for (const key of check.artifactKeys) keys.add(key)
  return { node, transitions, relevantChecks, requiredArtifacts: !definition && task.status !== 'done' ? artifacts : artifacts.filter(item => keys.has(item.key)) }
}

function completedExports(db: Database.Database, task: TaskSnapshot) {
  const sources = db.prepare<[string, string], { id: string; workflowId: string; version: number }>(`
    SELECT tasks.id, tasks.workflow_id AS workflowId, tasks.workflow_version AS version
    FROM tasks JOIN task_events e ON e.task_id = tasks.id AND e.type IN ('completed','transitioned')
    WHERE tasks.session_id = ? AND tasks.id <> ? AND tasks.status = 'done' AND tasks.workflow_id IS NOT NULL
    AND e.revision = tasks.revision ORDER BY e.rowid DESC
  `).all(task.sessionId, task.id)
  const workflows = createWorkflowRepository(db)
  const store = createArtifactStore(db)
  const seen = new Set<string>()
  const result: { workflowId: string; version: number; artifact: TaskArtifact }[] = []
  for (const source of sources) {
    const pinned = workflows.get(source.workflowId, source.version)
    const keys = pinned?.definition.contextExports.filter(key => !seen.has(source.workflowId + '/' + key)) ?? []
    if (!keys.length) continue
    for (const artifact of store.workflowArtifacts(source.id)) {
      if (!keys.includes(artifact.key)) continue
      result.push({ workflowId: source.workflowId, version: source.version, artifact })
      seen.add(source.workflowId + '/' + artifact.key)
    }
  }
  return result
}

export function prepareTaskContext(db: Database.Database, sessionId: string, taskId: string) {
  return db.transaction(() => readTaskContext(db, sessionId, taskId)).deferred()
}

function readTaskContext(db: Database.Database, sessionId: string, taskId: string) {
  const repository = createTaskRepository(db)
  const task = repository.get(taskId)
  if (!task || task.sessionId !== sessionId) throw new TaskError('NOT_FOUND', 'Task was not found')
  const pinned = task.workflowId ? createWorkflowRepository(db).get(task.workflowId, task.workflowVersion!) : undefined
  const material = currentMaterial(task, pinned ?? undefined, createArtifactStore(db).workflowArtifacts(taskId))
  const artifactIds = new Set(material.requiredArtifacts.map(artifact => artifact.id))
  const approvals = createApprovalStore(db).list(taskId).filter(approval =>
    approval.status !== 'obsolete' && artifactIds.has(approval.artifact.id))
  const checks = new Map(material.relevantChecks.map(check => [check.id, check]))
  const latestResults = new Map<string, ReturnType<typeof repository.listValidations>[number]>()
  for (const row of repository.listValidations(taskId)) {
    if (row.nodeVisitId === task.nodeVisitId && checks.has(row.checkId)) latestResults.set(row.checkId, row)
  }
  const validations = [...latestResults.values()].filter(row => {
    const keys = checks.get(row.checkId)!.artifactKeys
    const inputs = material.requiredArtifacts.filter(artifact => keys.includes(artifact.key))
    return row.inputs.length === inputs.length && row.inputs.every(ref => inputs.some(artifact => artifact.id === ref.id))
  })
  const required = block({ task, workflowHash: pinned?.hash ?? null, ...material, approvals, validations }, 'Current task context')
  const exports = completedExports(db, task)
  const exported = block(exports, 'Completed task exports')
  const instructions = [taskInstructions, '<current_task>', required, '</current_task>',
    ...(exports.length ? ['<completed_task_exports>', exported, '</completed_task_exports>'] : [])].join('\n')
  return { task, instructions, requiredArtifacts: material.requiredArtifacts, exportedContext: exports.map(item => item.artifact),
    estimatedTokens: Math.ceil(Buffer.byteLength(instructions) / 2), hash: createHash('sha256').update(instructions).digest('hex'),
    workflowHash: pinned?.hash ?? null, allowedWorkingTools: material.node?.allowedTools ?? null }
}
