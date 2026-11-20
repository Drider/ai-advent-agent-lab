import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { expect } from 'vitest'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkflowRepository } from '../server/workflows/repository'
import { createTaskService } from '../server/tasks/commands'
import type { JsonValue, TaskActorContext, TaskCommand, TaskErrorCode } from '../shared/task'
import type { WorkflowDefinition, WorkflowNode, WorkflowTransition } from '../shared/workflow'

function node(id: string, kind: WorkflowNode['kind'], writableArtifacts: string[], requiredApprovalKeys: string[] = []): WorkflowNode {
  return { id, kind, stage: id, label: id.toUpperCase(), writableArtifacts, requiredApprovalKeys,
    expected: kind === 'approval' ? { actor: 'user', kind: 'approval', label: 'Approve plan', artifactKey: 'plan' }
      : { actor: 'agent', kind: 'artifact', label: id }, allowedTools: [], checkIds: kind === 'validation' ? ['structure'] : [] }
}

function edge(id: string, from: string, to: string, overrides: Partial<WorkflowTransition> = {}): WorkflowTransition {
  return { id, from, to, event: 'advance', actor: 'agent', invalidateApprovalKeys: [], guards: [], ...overrides }
}

export const workflow: WorkflowDefinition = {
  schemaVersion: 1, entryNodeId: 'draft', resultArtifactKey: 'code',
  artifactSlots: [{ key: 'plan', type: 'plan' }, { key: 'code', type: 'implementation' }, { key: 'context', type: 'note' }],
  nodes: [node('draft', 'work', ['plan', 'context']), node('review', 'approval', ['plan']),
    node('build', 'work', ['code'], ['plan']), node('verify', 'validation', [], ['plan']), node('done', 'success', [])],
  transitions: [
    edge('review', 'draft', 'review', { guards: [{ kind: 'artifact_present', artifactKey: 'plan' }] }),
    edge('accept', 'review', 'build', { actor: 'user', event: 'approve', guards: [{ kind: 'approval_current', artifactKey: 'plan' }] }),
    edge('verify', 'build', 'verify', { guards: [{ kind: 'approval_current', artifactKey: 'plan' }] }),
    edge('revise', 'build', 'draft', { invalidateApprovalKeys: ['plan'] }),
    edge('finish', 'verify', 'done', { actor: 'system', event: 'checks_passed', guards: [{ kind: 'checks_current', checkIds: ['structure'] }] }),
    edge('shortcut', 'draft', 'done'), edge('needs_context', 'draft', 'draft', { guards: [{ kind: 'artifact_present', artifactKey: 'context' }] }),
  ],
  checks: [{ id: 'structure', kind: 'fields', artifactKeys: ['code'], options: { fields: [] } }],
  completionCheckIds: ['structure'], contextExports: [],
}

export function material(key: string, content: JsonValue): Extract<TaskCommand, { type: 'submit_artifact' }> {
  return { type: 'submit_artifact', key, content, sourceMessageIds: [], sourceToolCallIds: [] }
}

export function fixture(db: Database.Database, basic = false, definition = workflow) {
  const { id: sessionId } = createSessionRepository(db).createSession()
  const workflows = createWorkflowRepository(db)
  const published = workflows.create('Workflow', definition)
  const service = createTaskService(db)
  const created = service.create({ sessionId, task: 'Existing goal', operationId: randomUUID(),
    workflow: basic ? null : { id: published.workflowId, version: 1 } }, { sessionId, role: 'user' })
  if (!created.ok) throw new Error(created.error.code)
  const id = created.task.id
  const view = () => service.view(id, sessionId)
  function apply(command: TaskCommand, role: TaskActorContext['role'] = 'agent') {
    return service.apply(id, { command, operationId: randomUUID(), expectedRevision: view().task!.revision }, { role, sessionId })
  }
  async function ok(command: TaskCommand, role?: TaskActorContext['role']) {
    const result = await apply(command, role)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.error.code)
    return result.task
  }
  async function denied(command: TaskCommand, code: TaskErrorCode, role?: TaskActorContext['role']) {
    const before = view()
    expect(await apply(command, role)).toMatchObject({ ok: false, error: { code } })
    expect(view()).toEqual(before)
  }
  async function review() {
    await ok(material('plan', 'First draft'))
    await ok({ type: 'transition', transitionId: 'review' })
    return view().approvals.find(item => item.status === 'pending')!.id
  }
  return { db, service, id, sessionId, published, workflows, view, ok, denied, review }
}
