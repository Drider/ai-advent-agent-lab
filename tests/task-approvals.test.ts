import { afterEach, beforeEach, expect, it } from 'vitest'
import { createSessionRepository } from '../server/persistence/session-repository'
import { openChatDatabase } from '../server/persistence/db'
import { fixture, material, workflow } from './task-workflow-fixture'

let db: ReturnType<typeof openChatDatabase>
beforeEach(() => { db = openChatDatabase(':memory:') })
afterEach(() => db.close())

it('binds approval to a specific plan version and review visit and carries it into execution', async () => {
  const task = fixture(db)
  const first = await task.review()
  const originalVisit = task.view().task!.nodeVisitId
  await task.ok(material('plan', 'Updated draft'))
  const requests = task.view().approvals
  expect(requests).toContainEqual(expect.objectContaining({ id: first, status: 'obsolete' }))
  const current = requests.find(item => item.status === 'pending')!
  expect(current.artifact).toMatchObject({ key: 'plan', version: 2 })
  expect(task.view().actions).toContainEqual(expect.objectContaining({ type: 'approve', approvalId: current.id }))
  await task.denied({ type: 'approve', approvalId: first }, 'PLAN_APPROVAL_REQUIRED', 'user')
  const forged = { type: 'approve', approvalId: current.id, actor: 'user' } as const
  await task.denied(forged, 'TRANSITION_NOT_ALLOWED', 'agent')
  await task.denied({ type: 'transition', transitionId: 'accept' }, 'TRANSITION_NOT_ALLOWED', 'user')
  const build = await task.ok({ type: 'approve', approvalId: current.id }, 'user')
  expect(build).toMatchObject({ nodeId: 'build', stage: 'build', step: 'BUILD' })
  expect(build.nodeVisitId).not.toBe(originalVisit)
  await task.ok(material('code', 'built'))
  await task.ok({ type: 'transition', transitionId: 'revise' })
  expect(task.view().approvals.find(item => item.id === current.id)?.status).toBe('obsolete')
  await task.denied(material('code', 'bypass'), 'PLAN_APPROVAL_REQUIRED')
  await task.ok({ type: 'transition', transitionId: 'review' })
  const pending = task.view().approvals.find(item => item.status === 'pending')!
  expect(pending.id).not.toBe(current.id)
  expect(pending.artifact).toEqual(current.artifact)
  expect(task.view().task?.nodeVisitId).not.toBe(originalVisit)
  await task.denied({ type: 'approve', approvalId: current.id }, 'PLAN_APPROVAL_REQUIRED', 'user')
})

it('rejects requests and actor sessions belonging to a different task', async () => {
  const first = fixture(db)
  const second = fixture(db)
  const otherId = await second.review()
  await first.review()
  await first.denied({ type: 'approve', approvalId: otherId }, 'NOT_FOUND', 'user')
  const before = first.view()
  expect(await first.service.apply(first.id, { operationId: 'foreign', expectedRevision: before.task!.revision,
    command: { type: 'approve', approvalId: otherId } }, { sessionId: second.sessionId, role: 'user' }))
    .toMatchObject({ ok: false, task: null, error: { code: 'NOT_FOUND' } })
  expect(first.view()).toEqual(before)
})

it('keeps the request pending when a guard on its approval transition denies entry', async () => {
  const definition = structuredClone(workflow)
  definition.transitions.find(edge => edge.id === 'accept')!.guards.push({ kind: 'artifact_present', artifactKey: 'context' })
  const task = fixture(db, false, definition)
  const approvalId = await task.review()
  await task.denied({ type: 'approve', approvalId }, 'TRANSITION_NOT_ALLOWED', 'user')
  expect(task.view().approvals).toMatchObject([{ id: approvalId, status: 'pending' }])
})

it('rejects creation at an approval entry with no current artifact for the request', () => {
  const definition = structuredClone(workflow)
  definition.entryNodeId = 'review'
  definition.nodes.find(node => node.id === 'review')!.writableArtifacts = []
  const { service, published } = fixture(db, true, definition)
  const { id: sessionId } = createSessionRepository(db).createSession()
  const command = { sessionId, task: 'New task', operationId: 'create-at-review', workflow: { id: published.workflowId, version: 1 } }
  const rejected = service.create(command, { sessionId, role: 'user' })
  expect(rejected).toMatchObject({ ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' }, task: null })
  expect(service.create(command, { sessionId, role: 'user' })).toEqual(rejected)
  expect(db.prepare('SELECT id FROM tasks WHERE session_id = ?').all(sessionId)).toEqual([])
})
