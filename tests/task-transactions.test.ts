import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskService } from '../server/tasks/commands'
import type { TaskActorContext, TaskCommandEnvelope, TaskSnapshot } from '../shared/task'

const now = '2026-11-20T12:00:00.000Z'
const pause: TaskCommandEnvelope = { operationId: 'pause', expectedRevision: 0, command: { type: 'pause' } }

let directory: string
let file: string
let db: Database.Database
let service: ReturnType<typeof createTaskService>
let user: TaskActorContext
let task: TaskSnapshot

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'task-transactions-'))
  file = join(directory, 'chat.sqlite')
  db = openChatDatabase(file)
  const { id: sessionId } = createSessionRepository(db).createSession()
  user = { role: 'user', sessionId }
  service = createTaskService(db, { now: () => now })
  const result = service.create({ sessionId, task: 'Отчёт', operationId: 'create' }, user)
  if (!result.ok) throw new Error(result.error.code)
  task = result.task
})

afterEach(() => {
  if (db.open) db.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('transactional task commands', () => {
  it('replays a committed command after response loss', async () => {
    const first = await service.apply(task.id, pause, user)
    expect(await service.apply(task.id, pause, user)).toEqual(first)
    expect(db.prepare("SELECT id FROM task_events WHERE task_id = ? AND type = 'paused'").all(task.id)).toHaveLength(1)
  })

  it('binds a receipt to content, revision, task, session and role', async () => {
    await service.apply(task.id, pause, user)
    const { id: sessionId } = createSessionRepository(db).createSession()
    for (const [id, envelope, actor] of [
      [task.id, { ...pause, command: { type: 'cancel' } }, user],
      [task.id, { ...pause, expectedRevision: 1 }, user],
      ['other-task', pause, user],
      [task.id, pause, { role: 'user', sessionId }],
      [task.id, pause, { ...user, role: 'agent' }],
    ] satisfies Array<[string, TaskCommandEnvelope, TaskActorContext]>) {
      expect(await service.apply(id, envelope, actor)).toMatchObject({
        ok: false, error: { code: 'OPERATION_CONFLICT' },
      })
    }
    expect(service.view(task.id, sessionId).task).toBeNull()
  })

  it('replays a stale rejection while preserving the accepted revision', async () => {
    const cancel: TaskCommandEnvelope = { operationId: 'cancel', expectedRevision: 0, command: { type: 'cancel' } }
    await service.apply(task.id, pause, user)
    const rejected = await service.apply(task.id, cancel, user)
    expect(rejected).toMatchObject({ ok: false, error: { code: 'STALE_TASK_REVISION' }, task: { revision: 1 } })
    expect(db.prepare("SELECT phase FROM task_commands WHERE operation_id = 'cancel'").get()).toEqual({ phase: 'rejected' })
    await service.apply(task.id, { operationId: 'resume', expectedRevision: 1, command: { type: 'resume' } }, user)
    expect(await service.apply(task.id, cancel, user)).toEqual(rejected)
    expect(service.view(task.id, user.sessionId).task).toMatchObject({ status: 'active', revision: 2 })
  })

  it('checks cleared operations before replaying or creating tasks', async () => {
    await service.apply(task.id, pause, user)
    const markCleared = db.prepare('INSERT INTO cleared_requests (request_id, session_id, cleared_at) VALUES (?, ?, ?)')
    markCleared.run(pause.operationId, user.sessionId, now)
    markCleared.run('create', user.sessionId, now)
    expect(await service.apply(task.id, pause, user)).toMatchObject({
      ok: false, error: { code: 'OPERATION_CONFLICT' }, task: null,
    })
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
    expect(service.create({ sessionId: user.sessionId, operationId: 'create', task: 'Отчёт' }, user))
      .toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' }, task: null })
    expect(db.prepare('SELECT id FROM tasks').all()).toHaveLength(0)
  })

  it('rolls back result, status and receipt when inserting the event fails', async () => {
    db.exec(`
      CREATE TEMP TRIGGER fail_task_event BEFORE INSERT ON task_events
      BEGIN SELECT RAISE(ABORT, 'injected task event failure'); END;
    `)
    const finish: TaskCommandEnvelope = {
      operationId: 'finish', expectedRevision: 0, command: { type: 'finish', resultText: 'Результат' },
    }
    await expect(service.apply(task.id, finish, user)).rejects.toThrow('injected task event failure')
    expect(service.view(task.id, user.sessionId).task).toEqual(task)
    expect(db.prepare("SELECT operation_id FROM task_commands WHERE operation_id = 'finish'").get()).toBeUndefined()
    expect(db.prepare("SELECT id FROM task_events WHERE operation_id = 'finish'").get()).toBeUndefined()
    expect(db.prepare('SELECT id FROM task_artifacts WHERE task_id = ?').all(task.id)).toHaveLength(0)

    db.exec('DROP TRIGGER fail_task_event')
    expect(await service.apply(task.id, finish, user)).toMatchObject({ ok: true, task: { status: 'done' } })
  })

  it('accepts only one update at the same revision from two connections', async () => {
    const other = openChatDatabase(file)
    try {
      const otherService = createTaskService(other, { now: () => now })
      const expectedRevision = otherService.view(task.id, user.sessionId).task!.revision
      expect(expectedRevision).toBe(task.revision)
      const [first, second] = await Promise.all([
        service.apply(task.id, pause, user),
        otherService.apply(task.id, { operationId: 'cancel', expectedRevision, command: { type: 'cancel' } }, user),
      ])
      expect(first).toMatchObject({ ok: true, task: { revision: 1 } })
      expect(second).toMatchObject({ ok: false, error: { code: 'STALE_TASK_REVISION' }, task: { revision: 1 } })
    } finally {
      other.close()
    }
  })

  it('preserves expected action, progress and result after reopening the database', async () => {
    const expected = { actor: 'user', kind: 'input', label: 'Уточнить период' } as const
    await service.apply(task.id, {
      operationId: 'progress', expectedRevision: 0,
      command: { type: 'update_progress', progress: 'Данные собраны', expected },
    }, { ...user, role: 'agent' })
    const finish: TaskCommandEnvelope = {
      operationId: 'finish', expectedRevision: 1, command: { type: 'finish', resultText: 'Отчёт за ноябрь' },
    }
    const completed = await service.apply(task.id, finish, user)
    db.close()

    db = openChatDatabase(file)
    service = createTaskService(db)
    expect(service.view(task.id, user.sessionId).task).toMatchObject({
      status: 'done', expected, progress: 'Данные собраны', revision: 2, result: { type: 'result' },
    })
    expect(await service.apply(task.id, finish, user)).toEqual(completed)
  })
})
