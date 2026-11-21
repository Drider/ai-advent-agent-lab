import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startMemoryAwareTurn } from '../server/memory/start-turn'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskRepository } from '../server/persistence/task-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('session task detail', () => {
  it('includes the latest task in session details', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    createTaskRepository(db).start(session.id, { templateId: 'dev', goal: 'Сделать отчёт' })

    const detail = await createSessionRepository(db).getSession(session.id)
    expect(detail?.task).toMatchObject({
      goal: 'Сделать отчёт',
      stage: 'planning',
      status: 'active',
      revision: 0,
      allowedTransitions: ['execution'],
      pendingTransition: null,
    })
  })

  it('uses the same approved snapshot for session reload and the next turn', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'dev', goal: 'Сделать отчёт' })
    const turnId = createTurnRepository(db).beginUserTurn({
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'mock',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'План' }] },
      agentConfig: {},
    }).turnId
    const pending = tasks.requestTransition(session.id, { to: 'execution', summary: 'План готов' }, { turnId })
    createTurnRepository(db).finishTurn({
      turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Подтвердите' }] },
      status: 'completed',
    })
    const approved = tasks.approve(session.id, {
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
    })

    const reloaded = (await createSessionRepository(db).getSession(session.id))!.task!
    const next = startMemoryAwareTurn(db, {
      request: {
        kind: 'message',
        sessionId: session.id,
        requestId: randomUUID(),
        message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Продолжить задачу' }] },
      },
      modelId: 'mock',
      agentConfig: {},
    }).taskSnapshot!

    const expected = {
      stage: approved.stage,
      revision: approved.revision,
      lastTransition: { id: pending.pendingTransition!.id, outcome: 'approved' },
    }
    expect(reloaded).toMatchObject(expected)
    expect(next).toMatchObject(expected)
  })
})
