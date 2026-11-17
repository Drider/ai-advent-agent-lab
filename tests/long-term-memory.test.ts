import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { MemoryError } from '../server/memory/errors'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  const projects = createProjectRepository(db)
  const alpha = projects.create('Alpha')
  const beta = projects.create('Beta')
  const sessions = createSessionRepository(db)
  return { db, alpha, beta, sessions, repository: createLongTermMemoryRepository(db) }
}

describe('long-term memory', () => {
  it('stores one fact with multiple project connections and filters by project', () => {
    const { alpha, beta, repository } = setup()
    const fact = repository.create({ category: 'decision', key: 'database', value: 'SQLite', projectIds: [alpha.id, beta.id] })

    expect(repository.list({ projectId: alpha.id }).items).toEqual([fact])
    expect(repository.list({ projectId: beta.id }).items).toEqual([fact])
    expect(repository.list({ projectId: randomUUID() }).items).toEqual([])
    expect(repository.remove(fact.id)).toBeUndefined()
    expect(repository.list({ projectId: alpha.id }).items).toEqual([])
  })

  it('keeps global facts active after detaching a project and updates by revision', () => {
    const { alpha, beta, repository } = setup()
    const fact = repository.create({ category: 'profile', key: 'language', value: 'Russian', global: true, projectIds: [alpha.id, beta.id] })
    expect(repository.detachProject(alpha.id)).toBe(1)
    expect(repository.list({ projectId: alpha.id }).items).toEqual([expect.objectContaining({ id: fact.id })])
    expect(repository.update(fact.id, { value: 'Русский', expectedRevision: 0 }).value).toBe('Русский')
    expect(() => repository.update(fact.id, { value: 'stale', expectedRevision: 0 })).toThrow(MemoryError)
  })

  it('clears only long-term facts and nulls deleted message sources', () => {
    const { db, alpha, sessions, repository } = setup()
    const session = sessions.createSession()
    const messageId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO messages (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
      VALUES (?, ?, NULL, 0, 'user', 'complete', ?, 1, ?, ?)
    `).run(messageId, session.id, JSON.stringify({ id: messageId, role: 'user', parts: [{ type: 'text', text: 'source' }] }), timestamp, timestamp)
    const fact = repository.create({ category: 'knowledge', key: 'source', value: 'Saved', projectIds: [alpha.id], sourceSessionId: session.id, sourceMessageId: messageId })
    expect(repository.clear()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM working_memory_entries').get()).toEqual({ count: 0 })
    expect(fact.id).toBeTruthy()

    const second = repository.create({ category: 'knowledge', key: 'source', value: 'Saved', projectIds: [alpha.id], sourceSessionId: session.id, sourceMessageId: messageId })
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    expect(repository.list().items.find(item => item.id === second.id)).toMatchObject({ value: 'Saved', sourceSessionId: session.id })
    expect(db.prepare('SELECT source_message_id FROM long_term_facts WHERE id = ?').get(second.id)).toEqual({ source_message_id: null })
  })
})
