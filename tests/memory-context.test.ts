import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createMemorySettingsRepository } from '../server/memory/settings-repository'
import { assertMemoryBudgets, createMemorySnapshot, previewMemory } from '../server/memory/context'
import { MemoryError } from '../server/memory/errors'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('memory context snapshots', () => {
  it('selects project memory and global facts without duplicates or disabled records', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const other = createProjectRepository(db).create('Beta')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const working = createWorkingMemoryRepository(db)
    working.create({ projectId: project.id, category: 'goal', key: 'target', value: 'ship' })
    working.create({ projectId: other.id, category: 'goal', key: 'other', value: 'hide' })
    working.create({ projectId: project.id, category: 'note', key: 'off', value: 'hide', enabled: false })
    const longTerm = createLongTermMemoryRepository(db)
    const global = longTerm.create({ category: 'profile', key: 'language', value: 'ru', global: true, projectIds: [project.id] })
    longTerm.create({ category: 'knowledge', key: 'other', value: 'hide', projectIds: [other.id] })
    longTerm.create({ category: 'knowledge', key: 'off', value: 'hide', global: true, enabled: false })

    const snapshot = createMemorySnapshot(db, session.id)
    expect(snapshot.projectId).toBe(project.id)
    expect(snapshot.workingEntries.map(item => item.key)).toEqual(['target'])
    expect(snapshot.longTermFacts.map(item => item.id)).toEqual([global.id])
    expect(snapshot.longTermRefs).toEqual([{ id: global.id, revision: 0, reasons: ['global', 'project'] }])
    expect(snapshot.messages.map(message => message.id)).toEqual([
      `memory-${snapshot.id}-working`,
      `memory-${snapshot.id}-long-term`,
    ])
  })

  it('keeps an existing snapshot immutable and previews use current budgets', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const working = createWorkingMemoryRepository(db)
    const entry = working.create({ projectId: project.id, category: 'state', key: 'status', value: 'old' })
    const before = createMemorySnapshot(db, session.id)
    working.update(entry.id, { value: 'new', expectedRevision: 0 })
    const after = createMemorySnapshot(db, session.id)
    expect(before.workingEntries[0]?.value).toBe('old')
    expect(after.workingEntries[0]?.value).toBe('new')

    const firstPreview = previewMemory(db, project.id)
    createMemorySettingsRepository(db).update({ workingTokens: 4_000, longTermTokens: 1_000, expectedRevision: 0 })
    const secondPreview = previewMemory(db, project.id)
    expect(secondPreview.working.estimatedTokens).toBe(firstPreview.working.estimatedTokens)
    expect(secondPreview.working.budgetTokens).toBe(4_000)
    expect(secondPreview.longTerm.budgetTokens).toBe(1_000)
  })

  it('rejects a layer that exceeds its independent budget', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    createWorkingMemoryRepository(db).create({ projectId: project.id, category: 'goal', key: 'large', value: 'x'.repeat(10_000) })
    createMemorySettingsRepository(db).update({ workingTokens: 100, expectedRevision: 0 })
    expect(() => assertMemoryBudgets(createMemorySnapshot(db, session.id))).toThrowError(MemoryError)
    try {
      assertMemoryBudgets(createMemorySnapshot(db, session.id))
    } catch (error) {
      expect(error).toMatchObject({ code: 'MEMORY_BUDGET_EXCEEDED', layer: 'working' })
    }
  })

  it('loads enabled records beyond the management page and isolates project facts', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const projects = createProjectRepository(db)
    const project = projects.create('Alpha')
    const other = projects.create('Beta')
    const sessions = createSessionRepository(db)
    const projectSession = sessions.createSession({ projectId: project.id })
    const unassignedSession = sessions.createSession()
    const working = createWorkingMemoryRepository(db)
    for (let index = 0; index < 100; index += 1) {
      working.create({ projectId: project.id, category: 'note', key: `archived-${String(index).padStart(3, '0')}`, value: 'disabled', enabled: false })
    }
    const enabledEntry = working.create({ projectId: project.id, category: 'note', key: 'visible-after-page', value: 'keep' })

    const longTerm = createLongTermMemoryRepository(db)
    for (let index = 0; index < 100; index += 1) {
      longTerm.create({ category: 'knowledge', key: `archived-${String(index).padStart(3, '0')}`, value: 'disabled', global: true, enabled: false })
    }
    const globalFact = longTerm.create({ category: 'knowledge', key: 'global-after-page', value: 'keep', global: true })
    longTerm.create({ category: 'knowledge', key: 'project-only', value: 'hide', projectIds: [other.id] })

    const query = { id: randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'keep' }] }
    const projectSnapshot = createMemorySnapshot(db, projectSession.id, query)
    expect(projectSnapshot.workingEntries.map(entry => entry.id)).toEqual([enabledEntry.id])
    expect(projectSnapshot.longTermFacts.map(fact => fact.id)).toEqual([globalFact.id])

    const unassignedSnapshot = createMemorySnapshot(db, unassignedSession.id, query)
    expect(unassignedSnapshot.longTermFacts.map(fact => fact.id)).toEqual([globalFact.id])
  })
})
