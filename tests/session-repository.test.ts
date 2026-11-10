import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatUIMessage } from '../shared/chat'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-sessions-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function saveMessage(db: Database.Database, sessionId: string, message: ChatUIMessage, position: number): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).run(message.id, sessionId, position, message.role, 'complete', JSON.stringify(message), 1, now, now)
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('session repository', () => {
  it('creates unique sessions and collision-free diagnostic run IDs at one clock tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'))
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)

    const first = repository.createSession()
    const second = repository.createSession()

    expect(first.id).not.toBe(second.id)
    expect(first.runLogId).not.toBe(second.runLogId)
    expect(first.runLogId).toMatch(/^2026-11-10T12:00:00\.000Z$/)
    expect(second.runLogId).toMatch(/^2026-11-10T12:00:00\.001Z$/)
    db.close()
  })

  it('reopens messages in order with complete parts and metadata', async () => {
    const filePath = await createDatabasePath()
    const db = openChatDatabase(filePath)
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const savedMessages: ChatUIMessage[] = [
      {
        id: randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: 'Привет' }],
      },
      {
        id: randomUUID(),
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Ответ' },
          { type: 'reasoning', text: 'Проверяю контекст' },
        ],
        metadata: {
          durationMs: 123,
          usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        },
      },
    ]
    savedMessages.forEach((message, position) => saveMessage(db, session.id, message, position))
    db.close()

    const reopened = createSessionRepository(openChatDatabase(filePath))
    await expect(reopened.getSession(session.id)).resolves.toMatchObject({
      id: session.id,
      messages: savedMessages,
    })
  })

  it('paginates stably and returns a preferred session outside the first page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'))
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)
    const sessions = [repository.createSession(), repository.createSession(), repository.createSession()]
    repository.activateSession(sessions[0]!.id)

    const firstPage = repository.listSessions({ limit: 2 })
    const secondPage = repository.listSessions({ limit: 2, cursor: firstPage.nextCursor })

    expect(firstPage.items).toHaveLength(2)
    expect(secondPage.items).toHaveLength(1)
    expect(new Set([...firstPage.items, ...secondPage.items].map(item => item.id))).toEqual(
      new Set(sessions.map(session => session.id)),
    )
    expect(firstPage.preferredSessionId).toBe(sessions[0]!.id)
    db.close()
  })

  it('raises a typed storage error for malformed JSON and unsupported versions', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const repository = createSessionRepository(db)
    const session = repository.createSession()
    const message: ChatUIMessage = {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Сохрани меня' }],
    }
    saveMessage(db, session.id, message, 0)

    db.pragma('ignore_check_constraints = ON')
    db.prepare('UPDATE messages SET payload_json = ? WHERE id = ?').run('{bad-json', message.id)
    db.pragma('ignore_check_constraints = OFF')
    await expect(repository.getSession(session.id)).rejects.toMatchObject({ code: 'INVALID_STORED_MESSAGE' })

    db.prepare('UPDATE messages SET payload_json = ?, storage_version = ? WHERE id = ?')
      .run(JSON.stringify(message), 99, message.id)
    await expect(repository.getSession(session.id)).rejects.toMatchObject({ code: 'UNSUPPORTED_STORAGE_VERSION' })
    db.close()
  })
})
