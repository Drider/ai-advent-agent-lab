import { afterEach, beforeEach, expect, it } from 'vitest'
import { createArtifactStore } from '../server/tasks/artifacts'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { openChatDatabase } from '../server/persistence/db'
import { fixture, material } from './task-workflow-fixture'

let db: ReturnType<typeof openChatDatabase>
beforeEach(() => { db = openChatDatabase(':memory:') })
afterEach(() => db.close())

it('keeps immutable versions and reuses the current canonical material', async () => {
  const task = fixture(db)
  const first = await task.ok(material('plan', { a: 1, b: 2 }))
  const same = await task.ok(material('plan', { b: 2, a: 1 }))
  expect(same.artifacts).toEqual(first.artifacts)
  const changed = await task.ok(material('plan', { a: 3 }))
  expect(changed.artifacts).toMatchObject([{ type: 'plan', version: 2 }])
  expect(db.prepare('SELECT content_json FROM task_artifacts WHERE id = ?').get(first.artifacts[0]!.id))
    .toEqual({ content_json: '{"a":1,"b":2}' })
  expect(createArtifactStore(db).latest(task.id, 'plan')).toMatchObject({ ...changed.artifacts[0], content: { a: 3 } })
  expect(createArtifactStore(db).latest('foreign-task', 'plan')).toBeNull()
})

it('checks slot permissions and source ownership before storing material', async () => {
  const task = fixture(db)
  await task.denied(material('undeclared', true), 'TRANSITION_NOT_ALLOWED')
  await task.denied({ ...material('plan', 'text'), sourceMessageIds: ['unknown-message'] }, 'INVALID_INPUT')
  await task.denied({ ...material('plan', 'text'), sourceToolCallIds: ['foreign-call'] }, 'INVALID_INPUT')
  expect(task.view().task?.artifacts).toEqual([])
})

it('accepts only tool receipts from turns after this task attached its workflow', async () => {
  const task = fixture(db, true)
  const turns = createTurnRepository(db)
  function recordCall(position: number, toolCallId: string) {
    const turnId = 'turn-' + position
    const timestamp = '2026-11-20T12:00:00.000Z'
    db.prepare(`INSERT INTO turns (id, task_id, session_id, request_id, position, status, model_id,
      agent_config_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', 'mock', '{}', ?, ?)`)
      .run(turnId, task.id, task.sessionId, turnId, position, timestamp, timestamp)
    expect(turns.recordToolStart({ turnId, toolCallId, name: 'read_file', stepIndex: 0, input: {} })).toBe(true)
    turns.recordToolEnd({ turnId, toolCallId, output: { ok: true, content: 'material' } })
    turns.markStopped(turnId)
  }
  recordCall(0, 'prior-read')
  await task.ok({ type: 'attach', workflowId: task.published.workflowId, version: 1 }, 'user')
  recordCall(1, 'workflow-read')
  const plan = material('plan', 'Fresh material')
  await task.denied({ ...plan, sourceToolCallIds: ['prior-read'] }, 'INVALID_INPUT')
  await task.denied({ ...plan, sourceToolCallIds: ['workflow-read', 'prior-read'] }, 'INVALID_INPUT')
  await task.ok({ ...plan, sourceToolCallIds: ['workflow-read'] })
})
