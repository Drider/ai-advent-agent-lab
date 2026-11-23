import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { MemoryError } from '../server/memory/errors'
import { listMemoryChanges } from '../server/memory/change-log'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  const project = createProjectRepository(db).create('Alpha')
  return { db, project, sessions: createSessionRepository(db), repository: createWorkingMemoryRepository(db) }
}

describe('working memory', () => {
  it('keeps entries isolated by project and clears only the selected project', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const projects = createProjectRepository(db)
    const alpha = projects.create('Alpha')
    const beta = projects.create('Beta')
    const repository = createWorkingMemoryRepository(db)
    const entry = repository.create({ projectId: alpha.id, category: 'goal', key: 'Goal', value: 'Ship memory' })
    repository.create({ projectId: beta.id, category: 'goal', key: 'Goal', value: 'Ship beta' })

    expect(repository.list(alpha.id).items).toEqual([entry])
    expect(repository.clear(alpha.id)).toBe(1)
    expect(repository.list(alpha.id).items).toEqual([])
    expect(repository.list(beta.id).items).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM long_term_facts').get()).toEqual({ count: 0 })
  })

  it('uses optimistic revisions and keeps duplicate keys as separate records', () => {
    const { project, repository } = setup()
    const first = repository.create({ projectId: project.id, category: 'note', key: 'same', value: 'one' })
    const second = repository.create({ projectId: project.id, category: 'note', key: 'same', value: 'two' })
    expect(second.id).not.toBe(first.id)
    expect(repository.update(first.id, { value: 'updated', expectedRevision: 0 }).value).toBe('updated')
    expect(() => repository.update(first.id, { value: 'stale', expectedRevision: 0 })).toThrow(MemoryError)
  })

  it('validates project and source references while allowing large disabled records', () => {
    const { project, repository } = setup()
    const large = repository.create({ projectId: project.id, category: 'note', key: 'large', value: 'x'.repeat(10_000), enabled: false })
    expect(large.enabled).toBe(false)
    expect(() => repository.create({ projectId: randomUUID(), category: 'note', key: 'bad', value: 'value' })).toThrow(MemoryError)
    expect(() => repository.create({ projectId: project.id, category: 'note', key: 'bad', value: 'value', sourceSessionId: randomUUID() })).toThrow(MemoryError)
  })

  it('replaces overwriteable entries by normalized key and logs the old and new value', () => {
    const { project, repository, db } = setup()
    const first = repository.upsert({
      projectId: project.id,
      category: 'constraint',
      key: ' СРОК ',
      value: '1 декабря',
      recordedAt: '2026-11-22T10:00:00.000Z',
    })
    const second = repository.upsert({
      projectId: project.id,
      category: 'state',
      key: 'срок',
      value: '15 декабря',
      recordedAt: '2026-11-22T11:00:00.000Z',
    })

    expect(first.status).toBe('created')
    expect(second).toMatchObject({ status: 'replaced', previousValue: '1 декабря', entry: { id: first.entry.id, category: 'state', value: '15 декабря' } })
    expect(repository.list(project.id).items).toHaveLength(1)
    expect(listMemoryChanges(db, { projectId: project.id, limit: 10 })).toEqual([
      expect.objectContaining({ action: 'replace', oldValue: '1 декабря', newValue: '15 декабря', memoryKey: 'срок' }),
    ])
  })

  it('appends result and note records instead of replacing them', () => {
    const { project, repository } = setup()
    expect(repository.upsert({ projectId: project.id, category: 'note', key: 'same', value: 'one' }).status).toBe('appended')
    expect(repository.upsert({ projectId: project.id, category: 'note', key: 'same', value: 'two' }).status).toBe('appended')
    expect(repository.list(project.id).items.map(item => item.value)).toEqual(expect.arrayContaining(['one', 'two']))
  })

  it('returns stale and keeps the newer value when recorded later than the incoming fact', () => {
    const { project, repository } = setup()
    repository.upsert({ projectId: project.id, category: 'state', key: 'status', value: 'new', recordedAt: '2026-11-22T11:00:00.000Z' })
    const stale = repository.upsert({ projectId: project.id, category: 'state', key: 'STATUS', value: 'old', recordedAt: '2026-11-22T10:00:00.000Z' })

    expect(stale).toMatchObject({ status: 'stale', entry: { value: 'new' } })
    expect(repository.list(project.id).items).toHaveLength(1)
  })

  it('forgets every category with the normalized key and logs each deletion', () => {
    const { project, repository, db } = setup()
    repository.create({ projectId: project.id, category: 'goal', key: 'Status', value: 'goal' })
    repository.create({ projectId: project.id, category: 'note', key: ' status ', value: 'note' })
    repository.create({ projectId: project.id, category: 'state', key: 'other', value: 'keep' })

    expect(repository.forgetByKey(project.id, 'STATUS')).toEqual(['goal', 'note'])
    expect(repository.list(project.id).items.map(item => item.value)).toEqual(['keep'])
    expect(listMemoryChanges(db, { projectId: project.id, limit: 10 }).map(change => change.action)).toEqual(['forget', 'forget'])
  })

  it('logs value changes from manual updates and removals', () => {
    const { project, repository, db } = setup()
    const entry = repository.create({ projectId: project.id, category: 'state', key: 'status', value: 'draft' })
    const updated = repository.update(entry.id, { value: 'ready', expectedRevision: entry.revision })
    repository.remove(updated.id)

    expect(listMemoryChanges(db, { projectId: project.id, limit: 10 }).map(change => ({ action: change.action, oldValue: change.oldValue, newValue: change.newValue }))).toEqual(expect.arrayContaining([
      { action: 'forget', oldValue: 'ready', newValue: undefined },
      { action: 'replace', oldValue: 'draft', newValue: 'ready' },
    ]))
  })
})
