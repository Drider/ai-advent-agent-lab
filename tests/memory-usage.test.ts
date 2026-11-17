import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createMemorySnapshot } from '../server/memory/context'
import { createMemoryUsageRepository } from '../server/memory/usage-repository'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('memory usage events', () => {
  it('records one event per prepared turn and no stored text', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const working = createWorkingMemoryRepository(db).create({ projectId: project.id, category: 'goal', key: 'secret-key', value: 'secret-value' })
    const fact = createLongTermMemoryRepository(db).create({ category: 'knowledge', key: 'fact-key', value: 'fact-value', global: true })
    const snapshot = createMemorySnapshot(db, session.id)
    const usage = createMemoryUsageRepository(db)
    const event = usage.recordPrepared({
      turnId: 'turn-1',
      snapshot,
      shortTerm: { count: 2, bytes: 100, estimatedTokens: 50 },
    })
    expect(usage.recordPrepared({ turnId: 'turn-1', snapshot, shortTerm: { count: 9, bytes: 9, estimatedTokens: 9 } })).toEqual(event)
    expect(event.workingRefs).toEqual([{ id: working.id, revision: 0, reasons: ['working_project'] }])
    expect(event.longTermRefs).toEqual([{ id: fact.id, revision: 0, reasons: ['global'] }])
    const raw = JSON.stringify(db.prepare('SELECT * FROM memory_usage_events').all())
    expect(raw).not.toContain('secret-value')
    expect(raw).not.toContain('fact-value')
    expect(raw).not.toContain('secret-key')
  })

  it('marks all events for a cleared dialogue without changing the event id', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const snapshot = createMemorySnapshot(db, session.id)
    const usage = createMemoryUsageRepository(db)
    const event = usage.recordPrepared({ turnId: 'turn-1', snapshot, shortTerm: { count: 1, bytes: 10, estimatedTokens: 5 } })
    usage.markSessionContextCleared(session.id)
    expect(db.prepare('SELECT id, context_cleared FROM memory_usage_events WHERE id = ?').get(event.id)).toEqual({ id: event.id, context_cleared: 1 })
  })
})
