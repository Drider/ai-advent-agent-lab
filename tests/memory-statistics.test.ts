import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createMemorySnapshot } from '../server/memory/context'
import { createMemoryUsageRepository } from '../server/memory/usage-repository'
import { getMemoryStatistics } from '../server/memory/statistics'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('memory statistics', () => {
  it('aggregates dialogue and project scopes and reports changed revisions', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const projects = createProjectRepository(db)
    const alpha = projects.create('Alpha')
    const beta = projects.create('Beta')
    const sessions = createSessionRepository(db)
    const first = sessions.createSession({ projectId: alpha.id })
    const second = sessions.createSession({ projectId: alpha.id })
    const other = sessions.createSession({ projectId: beta.id })
    const working = createWorkingMemoryRepository(db)
    const entry = working.create({ projectId: alpha.id, category: 'state', key: 'status', value: 'old' })
    const fact = createLongTermMemoryRepository(db).create({ category: 'profile', key: 'name', value: 'Ada', projectIds: [alpha.id] })
    const usage = createMemoryUsageRepository(db)
    usage.recordPrepared({ turnId: 'turn-a', snapshot: createMemorySnapshot(db, first.id), shortTerm: { count: 2, bytes: 20, estimatedTokens: 10 } })
    usage.recordPrepared({ turnId: 'turn-b', snapshot: createMemorySnapshot(db, second.id), shortTerm: { count: 3, bytes: 30, estimatedTokens: 15 } })
    usage.recordPrepared({ turnId: 'turn-c', snapshot: createMemorySnapshot(db, other.id), shortTerm: { count: 4, bytes: 40, estimatedTokens: 20 } })
    working.update(entry.id, { value: 'new', expectedRevision: 0 })

    const statistics = getMemoryStatistics(db, { scope: 'project', projectId: alpha.id })
    expect(statistics.preparedTurns).toBe(2)
    expect(statistics.stored.working.entries).toBe(1)
    expect(statistics.stored.longTerm.facts).toBe(1)
    expect(statistics.recordUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: entry.id, layer: 'working', preparedTurns: 2, revisionMismatch: true }),
      expect.objectContaining({ id: fact.id, layer: 'long_term', preparedTurns: 2, revisionMismatch: false }),
    ]))
    expect(getMemoryStatistics(db, { scope: 'dialogue', sessionId: first.id }).preparedTurns).toBe(1)
    expect(getMemoryStatistics(db, { scope: 'global' }).preparedTurns).toBe(3)
  })

  it('keeps cleared latest context visible as cleared instead of replacing it', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const sessions = createSessionRepository(db)
    const first = sessions.createSession()
    const second = sessions.createSession()
    const usage = createMemoryUsageRepository(db)
    usage.recordPrepared({ turnId: 'turn-old', snapshot: createMemorySnapshot(db, first.id), shortTerm: { count: 1, bytes: 1, estimatedTokens: 1 } })
    const latest = usage.recordPrepared({ turnId: 'turn-latest', snapshot: createMemorySnapshot(db, second.id), shortTerm: { count: 2, bytes: 2, estimatedTokens: 1 } })
    usage.markSessionContextCleared(second.id)
    expect(getMemoryStatistics(db, { scope: 'global' }).lastPrepared).toMatchObject({ id: latest.id, contextCleared: true })
  })
})
