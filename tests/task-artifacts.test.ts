import { afterEach, beforeEach, expect, it } from 'vitest'
import { createArtifactStore } from '../server/tasks/artifacts'
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
