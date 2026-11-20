import { removeTaskSchema } from './helpers/chat-db'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createMemorySnapshot } from '../server/memory/context'
import { createMemoryUsageRepository, readMemoryUsageEvent } from '../server/memory/usage-repository'
import { getMemoryStatistics } from '../server/memory/statistics'
import { createMemorySettingsRepository } from '../server/memory/settings-repository'
import { migrateChatDatabase } from '../server/persistence/migrations'

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
    const snapshot = createMemorySnapshot(db, session.id, { id: 'query', role: 'user', parts: [{ type: 'text', text: 'fact-value' }] })
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

  it('persists exclusion reasons without text and counts only included records', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const working = createWorkingMemoryRepository(db)
    const required = working.create({ projectId: project.id, category: 'goal', key: 'goal', value: 'ship' })
    const disabled = working.create({ projectId: project.id, category: 'goal', key: 'disabled-secret', value: 'private-value', enabled: false })
    const unrelated = working.create({ projectId: project.id, category: 'note', key: 'unrelated-secret', value: 'private-value' })
    const oversized = working.create({ projectId: project.id, category: 'note', key: 'sqlite', value: 'x'.repeat(2_000) })
    createMemorySettingsRepository(db).update({ workingTokens: 220, expectedRevision: 0 })
    const snapshot = createMemorySnapshot(db, session.id, { id: 'query', role: 'user', parts: [{ type: 'text', text: 'sqlite confidentialquery' }] })
    const event = createMemoryUsageRepository(db).recordPrepared({ turnId: 'turn', snapshot, shortTerm: { count: 1, bytes: 10, estimatedTokens: 5 } })
    const exclusions = [
      { id: disabled.id, revision: 0, layer: 'working', reason: 'disabled' },
      { id: unrelated.id, revision: 0, layer: 'working', reason: 'not_relevant' },
      { id: oversized.id, revision: 0, layer: 'working', reason: 'budget_exceeded' },
    ]
    expect(event.exclusions).toEqual(exclusions)
    expect(readMemoryUsageEvent(db, event.id)?.exclusions).toEqual(exclusions)
    const statistics = getMemoryStatistics(db, { scope: 'dialogue', sessionId: session.id })
    expect(statistics.lastPrepared?.exclusions).toEqual(exclusions)
    expect(statistics.recordUsage.map(item => item.id)).toEqual([required.id])
    const raw = JSON.stringify(db.prepare('SELECT * FROM memory_usage_events').all())
    for (const text of ['disabled-secret', 'unrelated-secret', 'private-value', 'confidentialquery']) expect(raw).not.toContain(text)
  })

  it('upgrades version 11 events with empty exclusions and preserves their counts', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const event = createMemoryUsageRepository(db).recordPrepared({ turnId: 'old-turn', snapshot: createMemorySnapshot(db, session.id), shortTerm: { count: 2, bytes: 20, estimatedTokens: 10 } })
    const columns = db.prepare("SELECT name FROM pragma_table_info('memory_usage_events')").all() as Array<{ name: string }>
    if (columns.some(column => column.name === 'exclusions_json')) db.exec('ALTER TABLE memory_usage_events DROP COLUMN exclusions_json')
    db.exec(`
      DROP TRIGGER IF EXISTS sessions_user_profile_required_insert;
      DROP TRIGGER IF EXISTS sessions_user_profile_required_update;
      DROP INDEX IF EXISTS sessions_user_profile_idx;
      DROP TABLE user_profile_settings;
      ALTER TABLE sessions DROP COLUMN user_profile_id;
      DROP TABLE user_profiles;
    `)
    removeTaskSchema(db)
    db.pragma('user_version = 11')

    migrateChatDatabase(db)
    expect(db.prepare("SELECT name FROM pragma_table_info('memory_usage_events')").all()).toContainEqual({ name: 'exclusions_json' })
    expect(readMemoryUsageEvent(db, event.id)).toMatchObject({ exclusions: [], shortTerm: { count: 2, bytes: 20, estimatedTokens: 10 } })
    migrateChatDatabase(db)
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_usage_events').get()).toEqual({ count: 1 })
  })
})
