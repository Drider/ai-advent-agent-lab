import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createMemorySettingsRepository } from '../server/memory/settings-repository'
import { MemoryError } from '../server/memory/errors'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('memory settings', () => {
  it('uses independent 2000-token defaults and persists one-sided updates', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const settings = createMemorySettingsRepository(db)

    expect(settings.get()).toEqual({ workingTokens: 2000, longTermTokens: 2000, revision: 0 })
    expect(settings.update({ workingTokens: 4000, expectedRevision: 0 })).toEqual({
      workingTokens: 4000,
      longTermTokens: 2000,
      revision: 1,
    })
  })

  it('rejects invalid budgets and stale revisions without changing the row', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const settings = createMemorySettingsRepository(db)

    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100001, '4000']) {
      expect(() => settings.update({ workingTokens: value as never, expectedRevision: 0 })).toThrow(MemoryError)
    }
    expect(() => settings.update({ longTermTokens: 3000, expectedRevision: 1 })).toThrow(MemoryError)
    expect(settings.get()).toEqual({ workingTokens: 2000, longTermTokens: 2000, revision: 0 })
  })

  it('creates the memory, model configuration, and user profile tables and keeps the migration idempotent', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)

    expect(db.pragma('user_version', { simple: true })).toBe(14)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'working_memory_entries', 'long_term_facts', 'project_long_term_facts', 'memory_settings', 'memory_usage_events', 'history_clear_operations', 'cleared_requests', 'cleared_tool_calls', 'model_configurations', 'user_profiles', 'user_profile_settings') ORDER BY name").all()).toEqual([
      { name: 'cleared_requests' },
      { name: 'cleared_tool_calls' },
      { name: 'history_clear_operations' },
      { name: 'long_term_facts' },
      { name: 'memory_settings' },
      { name: 'memory_usage_events' },
      { name: 'model_configurations' },
      { name: 'project_long_term_facts' },
      { name: 'projects' },
      { name: 'user_profile_settings' },
      { name: 'user_profiles' },
      { name: 'working_memory_entries' },
    ])
  })
})
