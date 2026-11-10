import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-db-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function insertSession(db: Database.Database, id = randomUUID()): string {
  const now = '2026-11-10T12:00:00.000Z'
  db.prepare(`
    INSERT INTO sessions
      (id, run_log_id, title, created_at, updated_at, last_opened_at, status, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, now, 'Новый диалог', now, now, null, 'idle', 0)
  return id
}

function insertMessage(db: Database.Database, sessionId: string, position: number, payload = '{}'): void {
  const now = '2026-11-10T12:00:00.000Z'
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), sessionId, null, position, 'user', 'complete', payload, 1, now, now)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('chat database', () => {
  it('opens, migrates, and reopens the same database idempotently', async () => {
    const filePath = await createDatabasePath()
    const first = openChatDatabase(filePath)

    expect(first.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(first.pragma('busy_timeout', { simple: true })).toBe(1000)
    expect(first.pragma('synchronous', { simple: true })).toBe(2)
    expect(first.pragma('user_version', { simple: true })).toBe(1)
    first.close()

    const second = openChatDatabase(filePath)
    expect(second.pragma('user_version', { simple: true })).toBe(1)
    expect(second.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name").all()).toEqual([
      { name: 'dice_rolls' },
      { name: 'messages' },
      { name: 'sessions' },
      { name: 'tool_executions' },
      { name: 'turns' },
    ])
    second.close()
  })

  it('rejects malformed JSON, duplicate positions, and broken foreign keys', async () => {
    const db = openChatDatabase(await createDatabasePath())
    const sessionId = insertSession(db)

    expect(() => insertMessage(db, sessionId, 0, '{not-json')).toThrow()
    insertMessage(db, sessionId, 0)
    expect(() => insertMessage(db, sessionId, 0)).toThrow()
    expect(() => db.prepare(`
      INSERT INTO turns
        (id, session_id, request_id, position, status, model_id, agent_config_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), randomUUID(), randomUUID(), 0, 'running', 'mock', '{}', '2026-11-10T12:00:00.000Z')).toThrow()
    db.close()
  })
})
