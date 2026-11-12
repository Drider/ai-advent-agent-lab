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
  it('passes every stored message to the model after the 100-message boundary', async () => {
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

    const context = await buildSessionContext(session.id, sessions)
    expect(context).toHaveLength(101)
    expect(context[0]?.parts).toEqual([{ type: 'text', text: 'message 0' }])
    expect(context[100]?.parts).toEqual([{ type: 'text', text: 'message 100' }])
    expect((await sessions.getSession(session.id))?.messages).toHaveLength(101)
    db.close()
  })

  it('bounds a long text history while retaining the first request and recent messages', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    for (let position = 0; position < 30; position += 1) {
      saveMessage(db, session.id, {
        id: randomUUID(),
        role: position % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: 'x'.repeat(9 * 1024) }],
      }, position)
    }

    const context = await buildSessionContext(session.id, sessions)
    expect(context.length).toBeLessThan(30)
    expect(context[0]?.parts).toEqual([{ type: 'text', text: 'x'.repeat(9 * 1024) }])
    expect(context.at(-1)?.parts).toEqual([{ type: 'text', text: 'x'.repeat(9 * 1024) }])
    expect(JSON.stringify(context).length).toBeLessThan(125_000)
    expect((await sessions.getSession(session.id))?.messages).toHaveLength(30)
    db.close()
  })

  it('omits old tool outputs from a large model context while keeping saved history intact', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    saveMessage(db, session.id, { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Сделай конспект' }] }, 0)
    const assistant: ChatUIMessage = {
      id: randomUUID(), role: 'assistant',
      parts: [
        { type: 'tool-read_pdf', toolCallId: 'read-1', state: 'output-available', input: { path: 'book.pdf', page: 1 }, output: { ok: true, data: { text: 'x'.repeat(180_000) } } } as never,
        { type: 'text', text: 'Глава 1: краткое содержание.' },
      ],
    }
    saveMessage(db, session.id, assistant, 1)
    saveMessage(db, session.id, { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Продолжай' }] }, 2)

    const context = await buildSessionContext(session.id, sessions)
    expect(context[1]?.parts).toEqual([{ type: 'text', text: 'Глава 1: краткое содержание.' }])
    expect((await sessions.getSession(session.id))?.messages[1]?.parts).toEqual(assistant.parts)
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
