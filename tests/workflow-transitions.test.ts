import { afterEach, beforeEach, expect, it } from 'vitest'
import { evaluateTransition } from '../server/tasks/workflow'
import { openChatDatabase } from '../server/persistence/db'
import { fixture, material, workflow } from './task-workflow-fixture'

let db: ReturnType<typeof openChatDatabase>
beforeEach(() => { db = openChatDatabase(':memory:') })
afterEach(() => db.close())

it('rejects unknown, out-of-order and resultless success edges without changing the task', async () => {
  const task = fixture(db)
  await task.denied({ type: 'transition', transitionId: 'unknown' }, 'TRANSITION_NOT_ALLOWED')
  await task.denied({ type: 'transition', transitionId: 'finish' }, 'TRANSITION_NOT_ALLOWED')
  await task.denied({ type: 'transition', transitionId: 'shortcut' }, 'INVALID_INPUT')
  await task.denied(material('code', 'implementation'), 'PLAN_APPROVAL_REQUIRED')
  await task.denied({ type: 'update_progress', progress: 'Done', expected: workflow.nodes[1]!.expected }, 'TRANSITION_NOT_ALLOWED')
  expect(await task.ok({ type: 'update_progress', progress: 'Working' })).toMatchObject({
    progress: 'Working', stage: 'draft', step: 'DRAFT', expected: workflow.nodes[0]!.expected,
  })
})

it('attaches at the pinned entry, preserving the task and treating prior material as history', async () => {
  const task = fixture(db, true)
  await task.ok(material('context', 'Old conversation'))
  const attach = { type: 'attach', workflowId: task.published.workflowId, version: 1 } as const
  await task.denied(attach, 'TRANSITION_NOT_ALLOWED', 'agent')
  db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(task.sessionId)
  await task.denied(attach, 'SESSION_RUNNING', 'user')
  db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(task.sessionId)
  expect(await task.ok(attach, 'user')).toMatchObject({ id: task.id, task: 'Existing goal', nodeId: 'draft', workflowVersion: 1 })
  task.workflows.publish(task.published.workflowId, 1, { ...workflow, entryNodeId: 'build' })
  await task.denied({ ...attach, version: 2 }, 'TRANSITION_NOT_ALLOWED', 'user')
  await task.denied({ type: 'transition', transitionId: 'needs_context' }, 'TRANSITION_NOT_ALLOWED')
  await task.ok(material('context', 'Old conversation'))
  await task.ok({ type: 'transition', transitionId: 'needs_context' })
  expect(task.view().task?.workflowVersion).toBe(1)
})

it('pauses and resumes planning, approval, execution and validation with their visit and evidence intact', async () => {
  const task = fixture(db)
  for (const nodeId of ['draft', 'review', 'build', 'verify']) {
    const before = task.view()
    expect(before.task?.nodeId).toBe(nodeId)
    const paused = await task.ok({ type: 'pause' }, 'user')
    expect(paused.nodeVisitId).toBe(before.task?.nodeVisitId)
    await task.denied({ type: 'transition', transitionId: 'shortcut' }, 'TASK_PAUSED')
    await task.denied(material('code', 'x'), 'TASK_PAUSED')
    if (nodeId === 'review') {
      await task.denied({ type: 'approve', approvalId: before.approvals[0]!.id }, 'TASK_PAUSED', 'user')
      expect(task.view().actions.map(action => action.type)).not.toContain('approve')
    }
    const resumed = await task.ok({ type: 'resume' }, 'user')
    expect(resumed).toEqual({ ...before.task, revision: before.task!.revision + 2, updatedAt: resumed.updatedAt })
    expect(task.view().approvals).toEqual(before.approvals)
    if (nodeId === 'draft') await task.review()
    if (nodeId === 'review') await task.ok({ type: 'approve', approvalId: before.approvals[0]!.id }, 'user')
    if (nodeId === 'build') await task.ok({ type: 'transition', transitionId: 'verify' })
  }
})

it('checks the exact result and eligible actor before scheduling workflow finish', async () => {
  const task = fixture(db)
  const approvalId = await task.review()
  await task.ok({ type: 'approve', approvalId }, 'user')
  const build = await task.ok(material('code', 'current'))
  await task.ok({ type: 'transition', transitionId: 'verify' })
  await task.denied({ type: 'finish', resultText: 'bypass' }, 'INVALID_INPUT')
  await task.denied({ type: 'finish', resultArtifactId: 'another-artifact' }, 'INVALID_INPUT', 'system')
  await task.denied({ type: 'finish', resultArtifactId: build.artifacts.find(a => a.key === 'code')!.id }, 'TRANSITION_NOT_ALLOWED')
  expect(task.view().validations).toEqual([])
})

it('checks exact task, visit, checker, inputs and latest outcome before entering success', async () => {
  const base = fixture(db).view().task!
  const ref = { id: 'current', key: 'code', type: 'implementation' as const, hash: 'hash', version: 2 }
  const task = { ...base, artifacts: [ref] }
  const artifact = { ...ref, taskId: task.id, content: 'code', createdAt: '', sourceMessageIds: [], sourceToolCallIds: [] }
  const validation = { id: 'check', taskId: task.id, checkId: 'structure', nodeVisitId: task.nodeVisitId!, checkerVersion: 1 as const,
    inputs: [ref], outcome: 'passed' as const, createdAt: '2026-11-20', details: {} }
  const actor = { role: 'agent' as const, sessionId: task.sessionId }
  for (const validations of [
    [], [{ ...validation, checkerVersion: 2 as 1 }], [{ ...validation, nodeVisitId: 'prior' }], [{ ...validation, taskId: 'other' }],
    [{ ...validation, inputs: [] }], [{ ...validation, inputs: [{ ...ref, hash: 'changed' }] }],
    [{ ...validation, inputs: [{ ...ref, version: 1 }] }], [{ ...validation, inputs: [{ ...ref, id: 'other' }] }],
    [validation, { ...validation, id: 'newer', outcome: 'error' as const, createdAt: '2026-11-21' }],
  ]) {
    expect(evaluateTransition(task, workflow, 'shortcut', { artifacts: [artifact], approvals: [], validations }, actor))
      .toEqual({ allowed: false, code: 'VALIDATION_REQUIRED' })
  }
  expect(evaluateTransition(task, workflow, 'shortcut', { artifacts: [{ ...artifact, content: ' ' }], approvals: [], validations: [validation] }, actor))
    .toEqual({ allowed: false, code: 'INVALID_INPUT' })
  const withoutPlanGuard = structuredClone(workflow)
  withoutPlanGuard.transitions.find(edge => edge.id === 'review')!.guards = []
  expect(evaluateTransition(task, withoutPlanGuard, 'review', { artifacts: [], approvals: [], validations: [] }, actor))
    .toEqual({ allowed: false, code: 'TRANSITION_NOT_ALLOWED' })
  expect(evaluateTransition(task, workflow, 'shortcut', { artifacts: [{ ...artifact, taskId: 'other' }], approvals: [], validations: [validation] }, actor))
    .toEqual({ allowed: false, code: 'VALIDATION_REQUIRED' })
  expect(evaluateTransition(task, workflow, 'shortcut', { artifacts: [artifact], approvals: [], validations: [validation] }, actor))
    .toEqual({ allowed: true, targetNodeId: 'done' })
})

it('rejects attachment at an approval entry even when a basic artifact shares its requested key', async () => {
  const definition = structuredClone(workflow)
  definition.entryNodeId = 'review'
  definition.nodes.find(node => node.id === 'review')!.writableArtifacts = []
  const task = fixture(db, true, definition)
  await task.ok(material('plan', 'Before activation'))
  await task.denied({ type: 'attach', workflowId: task.published.workflowId, version: 1 }, 'TRANSITION_NOT_ALLOWED', 'user')
  expect(task.view().approvals).toEqual([])
})
