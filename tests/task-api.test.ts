import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { createApp, createRouter, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateChatDatabase } from '../server/persistence/migrations'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskRepository } from '../server/persistence/task-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'

const databaseState = vi.hoisted((): { db: unknown } => ({ db: undefined }))

vi.mock('../server/persistence/db', () => ({ getChatDatabase: () => databaseState.db }))

import startTask from '../server/api/sessions/[id]/task.post'
import updateTask from '../server/api/sessions/[id]/task.patch'
import getSession from '../server/api/sessions/[id].get'
import saveTaskAnswers from '../server/api/sessions/[id]/task-answers.patch'

let db: Database.Database
let request: (path: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateChatDatabase(db)
  databaseState.db = db
  const router = createRouter()
    .get('/sessions/:id', getSession)
    .post('/sessions/:id/task', startTask)
    .patch('/sessions/:id/task', updateTask)
    .patch('/sessions/:id/task-answers', saveTaskAnswers)
  const handler = toWebHandler(createApp().use(router.handler))
  request = (path, init = {}) => handler(new Request(`http://local.test${path}`, init))
})

afterEach(() => db.close())

async function json(response: Response): Promise<any> {
  return response.json()
}

function body(method: string, payload: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
}

describe('task API', () => {
  it('starts a task and applies a user action with no-store responses', async () => {
    const session = createSessionRepository(db).createSession()
    const started = await request(`/sessions/${session.id}/task`, body('POST', { templateId: 'dev', goal: 'Сделать отчёт' }))
    expect(started.status).toBe(200)
    expect(started.headers.get('cache-control')).toContain('no-store')
    expect(await json(started)).toMatchObject({ task: { stage: 'planning', goal: 'Сделать отчёт' } })

    const paused = await request(`/sessions/${session.id}/task`, body('PATCH', { action: 'pause' }))
    expect(paused.status).toBe(200)
    expect(await json(paused)).toMatchObject({ task: { status: 'paused' } })
  })

  it('approves by pending id and revision and returns the same outcome on retry', async () => {
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'dev', goal: 'Сделать отчёт' })
    const turnId = randomUUID()
    createTurnRepository(db).beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'План' }] },
      agentConfig: {},
    })
    const pending = tasks.requestTransition(session.id, { to: 'execution', summary: 'План готов' }, { turnId })
    createTurnRepository(db).finishTurn({
      turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Готово' }] },
      status: 'completed',
    })
    const payload = {
      action: 'approve',
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
    }

    const approved = await request(`/sessions/${session.id}/task`, body('PATCH', payload))
    const repeated = await request(`/sessions/${session.id}/task`, body('PATCH', payload))

    expect(approved.status).toBe(200)
    const approvedResult = await json(approved)
    expect(approvedResult).toMatchObject({
      task: {
        stage: 'execution',
        revision: pending.revision + 1,
        lastTransition: { id: pending.pendingTransition!.id, outcome: 'approved' },
      },
    })
    expect(repeated.status).toBe(200)
    expect(await json(repeated)).toMatchObject({ task: { stage: 'execution', lastTransition: { outcome: 'approved' } } })

    const reloaded = await request(`/sessions/${session.id}`)
    expect(reloaded.status).toBe(200)
    expect((await json(reloaded)).task).toMatchObject({
      stage: approvedResult.task.stage,
      revision: approvedResult.task.revision,
      lastTransition: approvedResult.task.lastTransition,
    })
  })

  it('returns a fresh task snapshot for an optimistic concurrency conflict', async () => {
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'dev', goal: 'Сделать отчёт' })
    const turnId = randomUUID()
    createTurnRepository(db).beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'План' }] },
      agentConfig: {},
    })
    const pending = tasks.requestTransition(session.id, { to: 'execution', summary: 'План готов' }, { turnId })
    createTurnRepository(db).finishTurn({
      turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Готово' }] },
      status: 'completed',
    })

    const response = await request(`/sessions/${session.id}/task`, body('PATCH', {
      action: 'approve',
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: 0,
    }))
    const result = await json(response)

    expect(response.status).toBe(409)
    expect(result.data).toMatchObject({
      code: 'REVISION_CONFLICT',
      task: { stage: 'planning', revision: pending.revision, pendingTransition: { id: pending.pendingTransition!.id } },
    })
  })

  it('saves the onboarding form in one atomic request', async () => {
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    const answers = { name: 'Игорь', role: 'Разработчик', goal: 'Учёба', level: 'expert', style: 'detailed' }

    const response = await request(`/sessions/${session.id}/task-answers`, body('PATCH', { answers, expectedRevision: 0 }))

    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({ task: { revision: 1, answers } })
  })

  it('rejects bulk answers while a turn is running', async () => {
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'onboarding', goal: 'Знакомство' })
    createTurnRepository(db).beginUserTurn({
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'mock',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Анкета' }] },
      agentConfig: {},
    })

    const response = await request(`/sessions/${session.id}/task-answers`, body('PATCH', {
      answers: { name: 'Игорь', role: 'Разработчик', goal: 'Учёба', level: 'expert', style: 'detailed' },
      expectedRevision: 0,
    }))

    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ data: { code: 'SESSION_RUNNING' } })
    expect(createTaskRepository(db).getSnapshot(session.id)?.answers).toEqual({})
  })

  it('rejects extra keys and maps task errors to the documented statuses', async () => {
    const session = createSessionRepository(db).createSession()
    expect((await request(`/sessions/${session.id}/task`, body('POST', { templateId: 'dev', goal: 'ok', extra: true }))).status).toBe(400)
    expect((await request(`/sessions/${session.id}/task`, body('POST', { templateId: 'dev', goal: 'ok' })))).toHaveProperty('status', 200)
    expect((await request(`/sessions/${session.id}/task`, body('POST', { templateId: 'dev', goal: 'again' }))).status).toBe(409)
    expect((await request(`/sessions/${session.id}/task`, body('PATCH', { action: 'approve', stage: 'done' }))).status).toBe(409)
    expect((await request(`/sessions/${session.id}/task`, body('PATCH', { action: 'pause', stage: 'planning' }))).status).toBe(400)
  })
})
