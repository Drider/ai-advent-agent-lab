import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import type { ChatUIMessage } from '../shared/chat'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-continuation-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function userMessage(text: string): ChatUIMessage {
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('chat continuation', () => {
  it('allows a safe interrupted turn and creates a new turn', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const sourceTurnId = randomUUID()
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: sourceTurnId,
      modelId: 'mock-model',
      message: userMessage('Брось кубик'),
      agentConfig: { version: 1 },
    })
    turns.recordToolStart({ turnId: sourceTurnId, toolCallId: 'roll-1', stepIndex: 0, name: 'rollDie', input: { sides: 6 } })
    turns.recordToolEnd({ turnId: sourceTurnId, toolCallId: 'roll-1', output: { sides: 6, result: 4 } })
    turns.recoverRunningTurns()

    expect(turns.assessContinuation(sourceTurnId)).toBe('safe')
    const continuation = turns.beginContinuation({
      sessionId: session.id,
      requestId: randomUUID(),
      sourceTurnId,
      modelId: 'mock-model',
      agentConfig: { version: 1 },
    })
    expect(continuation.turnId).not.toBe(sourceTurnId)
    expect(turns.getLastTurn(session.id)?.sourceTurnId).toBe(sourceTurnId)
    db.close()
  })

  it('blocks continuation when a mutating tool result is uncertain', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const sourceTurnId = randomUUID()
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: sourceTurnId,
      modelId: 'mock-model',
      message: userMessage('Запиши файл'),
      agentConfig: { version: 1 },
    })
    turns.recordToolStart({ turnId: sourceTurnId, toolCallId: 'write-1', stepIndex: 0, name: 'write_file', input: { path: 'out.txt' } })
    turns.recoverRunningTurns()

    expect(turns.assessContinuation(sourceTurnId)).toBe('needs_review')
    expect(() => turns.beginContinuation({
      sessionId: session.id,
      requestId: randomUUID(),
      sourceTurnId,
      modelId: 'mock-model',
      agentConfig: { version: 1 },
    })).toThrow('unconfirmed tool result')
    db.close()
  })

  it('keeps an explicit stop after recovery', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const turnId = randomUUID()
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock-model',
      message: userMessage('Останови'),
      agentConfig: { version: 1 },
    })
    turns.markStopped(turnId)
    expect(turns.recoverRunningTurns()).toBe(0)
    expect(turns.getLastTurn(session.id)?.status).toBe('stopped')
    db.close()
  })
})
