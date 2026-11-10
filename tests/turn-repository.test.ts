import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatUIMessage } from '../shared/chat'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-turns-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function userMessage(text: string): ChatUIMessage {
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(text: string): ChatUIMessage {
  return { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text }] }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('turn repository', () => {
  it('commits the user message and running turn atomically', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const requestId = randomUUID()

    const started = turns.beginUserTurn({
      sessionId: session.id,
      requestId,
      modelId: 'mock-model',
      message: userMessage('Первый вопрос'),
      agentConfig: { version: 1, instructions: 'test' },
    })

    expect(started.turnId).toBe(requestId)
    await expect(sessions.getSession(session.id)).resolves.toMatchObject({
      messages: [{ role: 'user' }],
      lastTurn: { id: requestId, status: 'running' },
      status: 'running',
    })
    db.close()
  })

  it('rejects duplicate requests without adding a second user message', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const request = {
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'mock-model',
      message: userMessage('Повтор'),
      agentConfig: { version: 1 },
    }

    turns.beginUserTurn(request)
    expect(() => turns.beginUserTurn(request)).toThrow('TURN_ALREADY_EXISTS')
    expect((await sessions.getSession(session.id))?.messages).toHaveLength(1)
    db.close()
  })

  it('allows only one active turn in a session', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()

    turns.beginUserTurn({
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'mock-model',
      message: userMessage('Занято'),
      agentConfig: { version: 1 },
    })

    expect(() => turns.beginUserTurn({
      sessionId: session.id,
      requestId: randomUUID(),
      modelId: 'mock-model',
      message: userMessage('Второй запрос'),
      agentConfig: { version: 1 },
    })).toThrow('TURN_ALREADY_EXISTS')
    db.close()
  })

  it('commits the final assistant message and session status together', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const turnId = randomUUID()

    turns.beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock-model',
      message: userMessage('Заверши'),
      agentConfig: { version: 1 },
    })
    turns.finishTurn({ turnId, message: assistantMessage('Готово'), status: 'completed' })

    await expect(sessions.getSession(session.id)).resolves.toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant' }],
      lastTurn: { status: 'completed' },
      status: 'completed',
    })
    db.close()
  })

  it('recovers only running turns after reopening and preserves stopped turns', async () => {
    const filePath = await createDatabasePath()
    const firstDb = openChatDatabase(filePath)
    const sessions = createSessionRepository(firstDb)
    const turns = createTurnRepository(firstDb)
    const runningSession = sessions.createSession()
    const stoppedSession = sessions.createSession()
    const runningTurnId = randomUUID()
    const stoppedTurnId = randomUUID()

    for (const [sessionId, requestId] of [
      [runningSession.id, runningTurnId],
      [stoppedSession.id, stoppedTurnId],
    ] as const) {
      turns.beginUserTurn({
        sessionId,
        requestId,
        modelId: 'mock-model',
        message: userMessage('Восстановление'),
        agentConfig: { version: 1 },
      })
    }
    turns.markStopped(stoppedTurnId)
    firstDb.close()

    const secondDb = openChatDatabase(filePath)
    const reopenedTurns = createTurnRepository(secondDb)
    const reopenedSessions = createSessionRepository(secondDb)
    expect(reopenedTurns.recoverRunningTurns()).toBe(1)
    expect((await reopenedSessions.getSession(runningSession.id))?.lastTurn?.status).toBe('interrupted')
    expect((await reopenedSessions.getSession(stoppedSession.id))?.lastTurn?.status).toBe('stopped')
    secondDb.close()
  })
})
