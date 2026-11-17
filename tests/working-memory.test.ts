import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { MemoryError } from '../server/memory/errors'

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
})
