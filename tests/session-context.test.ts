import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatUIMessage } from '../shared/chat'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { buildSessionContext } from '../server/utils/session-context'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-context-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function saveMessage(db: ReturnType<typeof openChatDatabase>, sessionId: string, message: ChatUIMessage, position: number): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, 'complete', ?, 1, ?, ?)
  `).run(message.id, sessionId, position, message.role, JSON.stringify(message), now, now)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('session context', () => {
  it('rejects more than 100 stored messages without truncating session history', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    for (let position = 0; position < 101; position += 1) {
      saveMessage(db, session.id, {
        id: randomUUID(),
        role: position % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `message ${position}` }],
      }, position)
    }

    await expect(buildSessionContext(session.id, sessions)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_REACHED' })
    expect((await sessions.getSession(session.id))?.messages).toHaveLength(101)
    db.close()
  })

  it('rejects a serialized context larger than 256 KiB', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    saveMessage(db, session.id, {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(260 * 1024) }],
    }, 0)

    await expect(buildSessionContext(session.id, sessions)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_REACHED' })
    db.close()
  })

  it('excludes an interrupted trailing assistant snapshot from model context', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const user: ChatUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Продолжи' }] }
    const turnId = randomUUID()
    turns.beginUserTurn({
      sessionId: session.id,
      requestId: turnId,
      modelId: 'mock-model',
      message: user,
      agentConfig: { version: 1 },
    })
    turns.saveAssistantSnapshot({
      turnId,
      message: {
      id: randomUUID(),
      role: 'assistant',
      parts: [{ type: 'text', text: 'Частичный ответ' }],
      },
      status: 'partial',
    })
    turns.recoverRunningTurns()

    await expect(buildSessionContext(session.id, sessions)).resolves.toEqual([user])
    db.close()
  })
})
