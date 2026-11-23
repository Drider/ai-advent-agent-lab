import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { listMemoryChanges, recordMemoryChange } from '../server/memory/change-log'
import { createProjectRepository } from '../server/persistence/project-repository'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('memory change log', () => {
  it('records changes and shows project records plus global long-term records', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const projects = createProjectRepository(db)
    const alpha = projects.create('Alpha')
    const beta = projects.create('Beta')

    recordMemoryChange(db, {
      id: 'working-alpha',
      layer: 'working',
      entryId: 'entry-alpha',
      projectId: alpha.id,
      category: 'state',
      memoryKey: 'status',
      action: 'replace',
      oldValue: 'draft',
      newValue: 'ready',
      changedAt: '2026-11-22T10:00:00.000Z',
    })
    recordMemoryChange(db, {
      id: 'long-global',
      layer: 'long_term',
      entryId: 'fact-global',
      category: 'profile',
      memoryKey: 'language',
      action: 'replace',
      oldValue: 'English',
      newValue: 'Russian',
      changedAt: '2026-11-22T11:00:00.000Z',
    })
    recordMemoryChange(db, {
      id: 'working-beta',
      layer: 'working',
      entryId: 'entry-beta',
      projectId: beta.id,
      category: 'note',
      memoryKey: 'other',
      action: 'forget',
      oldValue: 'Only Beta',
      changedAt: '2026-11-22T12:00:00.000Z',
    })

    const changes = listMemoryChanges(db, { projectId: alpha.id, limit: 10 })
    expect(changes).toEqual([
      expect.objectContaining({ id: 'long-global', action: 'replace' }),
      expect.objectContaining({ id: 'working-alpha', projectId: alpha.id, newValue: 'ready' }),
    ])
    expect(changes[0]).not.toHaveProperty('projectId')
    expect(listMemoryChanges(db, { limit: 1 })).toHaveLength(1)
  })
})
