import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { MemoryError } from '../server/memory/errors'
import { listMemoryChanges } from '../server/memory/change-log'

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
    expect(repository.update(fact.id, { value: 'Русский', expectedRevision: 1 }).value).toBe('Русский')
    expect(() => repository.update(fact.id, { value: 'stale', expectedRevision: 1 })).toThrow(MemoryError)
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

  it('replaces overwriteable facts by normalized key within their scope', () => {
    const { alpha, beta, repository, db } = setup()
    const projectFact = repository.upsert({
      category: 'knowledge',
      key: ' Язык ',
      value: 'Русский',
      projectIds: [alpha.id],
      recordedAt: '2026-11-22T10:00:00.000Z',
    })
    const replaced = repository.upsert({
      category: 'profile',
      key: 'язык',
      value: 'English',
      projectIds: [alpha.id],
      recordedAt: '2026-11-22T11:00:00.000Z',
    })
    const otherProject = repository.upsert({
      category: 'knowledge',
      key: 'язык',
      value: 'Deutsch',
      projectIds: [beta.id],
      recordedAt: '2026-11-22T12:00:00.000Z',
    })
    const global = repository.upsert({
      category: 'profile',
      key: 'язык',
      value: 'Global',
      global: true,
      recordedAt: '2026-11-22T13:00:00.000Z',
    })

    expect(projectFact.status).toBe('created')
    expect(replaced).toMatchObject({ status: 'replaced', previousValue: 'Русский', entry: { id: projectFact.entry.id, category: 'profile', value: 'English' } })
    expect(otherProject.status).toBe('created')
    expect(global.status).toBe('created')
    expect(repository.list({ projectId: alpha.id }).items.map(item => item.value)).toEqual(expect.arrayContaining(['English', 'Global']))
    expect(listMemoryChanges(db, { projectId: alpha.id, limit: 10 })).toEqual([
      expect.objectContaining({ action: 'replace', oldValue: 'Русский', newValue: 'English', projectId: alpha.id }),
    ])
  })

  it('appends decisions and returns stale for an older overwriteable fact', () => {
    const { alpha, repository } = setup()
    expect(repository.upsert({ category: 'decision', key: 'database', value: 'SQLite', projectIds: [alpha.id] }).status).toBe('appended')
    expect(repository.upsert({ category: 'decision', key: 'database', value: 'Postgres', projectIds: [alpha.id] }).status).toBe('appended')
    repository.upsert({ category: 'knowledge', key: 'status', value: 'new', projectIds: [alpha.id], recordedAt: '2026-11-22T11:00:00.000Z' })
    const stale = repository.upsert({ category: 'knowledge', key: 'STATUS', value: 'old', projectIds: [alpha.id], recordedAt: '2026-11-22T10:00:00.000Z' })

    expect(repository.list({ projectId: alpha.id }).items.map(item => item.value)).toEqual(expect.arrayContaining(['SQLite', 'Postgres', 'new']))
    expect(stale).toMatchObject({ status: 'stale', entry: { value: 'new' } })
  })

  it('forgets all facts with a key in a project or global scope', () => {
    const { alpha, beta, repository, db } = setup()
    repository.create({ category: 'profile', key: 'Status', value: 'project', projectIds: [alpha.id] })
    repository.create({ category: 'knowledge', key: ' status ', value: 'global', global: true })
    repository.create({ category: 'decision', key: 'Status', value: 'decision', projectIds: [beta.id] })

    expect(repository.forgetByKey({ projectId: alpha.id }, 'STATUS')).toEqual(['project'])
    expect(repository.forgetByKey({ global: true }, 'status')).toEqual(['global'])
    expect(repository.list({ projectId: beta.id }).items.map(item => item.value)).toEqual(['decision'])
    expect(listMemoryChanges(db, { projectId: alpha.id, limit: 10 }).map(change => change.action)).toEqual(['forget', 'forget'])
  })

  it('logs value changes and removal from the memory editor', () => {
    const { alpha, repository, db } = setup()
    const fact = repository.create({ category: 'knowledge', key: 'status', value: 'draft', projectIds: [alpha.id] })
    const updated = repository.update(fact.id, { value: 'ready', expectedRevision: fact.revision })
    repository.remove(updated.id)

    expect(listMemoryChanges(db, { projectId: alpha.id, limit: 10 }).map(change => ({ action: change.action, oldValue: change.oldValue, newValue: change.newValue }))).toEqual(expect.arrayContaining([
      { action: 'forget', oldValue: 'ready', newValue: undefined },
      { action: 'replace', oldValue: 'draft', newValue: 'ready' },
    ]))
  })
})
