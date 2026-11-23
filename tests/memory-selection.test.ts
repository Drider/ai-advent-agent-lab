import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createMemorySettingsRepository } from '../server/memory/settings-repository'
import { assertMemoryBudgets, createMemorySnapshot, previewMemory } from '../server/memory/context'
import { startMemoryAwareTurn } from '../server/memory/start-turn'
import type { ChatUIMessage } from '../shared/chat'

const databases: ReturnType<typeof openChatDatabase>[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function message(text: string): ChatUIMessage {
  return { id: randomUUID(), role: 'user', parts: [{ type: 'text', text }] }
}

function setup() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  const project = createProjectRepository(db).create('Alpha')
  const otherProject = createProjectRepository(db).create('Beta')
  const session = createSessionRepository(db).createSession({ projectId: project.id })
  return { db, project, otherProject, session, working: createWorkingMemoryRepository(db), longTerm: createLongTermMemoryRepository(db) }
}

describe('memory selection rules', () => {
  it('includes the record update time and latest-value precedence in the prompt block', () => {
    const { db, project, session, working } = setup()
    working.create({ projectId: project.id, category: 'state', key: 'deadline', value: '15 декабря' })
    db.prepare('UPDATE working_memory_entries SET updated_at = ? WHERE project_id = ?').run('2026-11-22T14:05:37.000Z', project.id)

    const text = createMemorySnapshot(db, session.id).messages[0]?.parts
      .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
      .map(part => part.text)
      .join('') ?? ''
    expect(text).toContain('- [state] deadline (2026-11-22 14:05 UTC): 15 декабря')
    expect(text).toContain('If a memory record contradicts earlier dialogue messages, the memory record is authoritative.')
  })

  it('includes required categories and excludes disabled, unrelated and out-of-scope records', () => {
    const { db, project, otherProject, session, working, longTerm } = setup()
    for (const category of ['goal', 'constraint', 'state'] as const) working.create({ projectId: project.id, category, key: category, value: 'required' })
    const note = working.create({ projectId: project.id, category: 'note', key: 'optional', value: 'unrelated' })
    const result = working.create({ projectId: project.id, category: 'result', key: 'result', value: 'unrelated' })
    const disabled = working.create({ projectId: project.id, category: 'goal', key: 'disabled', value: 'hidden', enabled: false })
    const other = working.create({ projectId: otherProject.id, category: 'goal', key: 'other', value: 'hidden' })
    longTerm.create({ category: 'profile', key: 'language', value: 'Russian', global: true })
    const knowledge = longTerm.create({ category: 'knowledge', key: 'database', value: 'SQLite', global: true })
    const decision = longTerm.create({ category: 'decision', key: 'deploy', value: 'Vercel', projectIds: [project.id] })
    longTerm.create({ category: 'profile', key: 'other-profile', value: 'hidden', projectIds: [otherProject.id] })

    const snapshot = createMemorySnapshot(db, session.id)
    expect(snapshot.workingEntries.map(entry => entry.category)).toEqual(['constraint', 'goal', 'state'])
    expect(snapshot.longTermFacts.map(entry => entry.key)).toEqual(['language'])
    expect(snapshot.preview.exclusions).toEqual(expect.arrayContaining([
      { id: note.id, revision: 0, layer: 'working', reason: 'not_relevant' },
      { id: result.id, revision: 0, layer: 'working', reason: 'not_relevant' },
      { id: disabled.id, revision: 0, layer: 'working', reason: 'disabled' },
      { id: knowledge.id, revision: 0, layer: 'long_term', reason: 'not_relevant' },
      { id: decision.id, revision: 0, layer: 'long_term', reason: 'not_relevant' },
    ]))
    expect(snapshot.preview.exclusions).toHaveLength(5)
    expect(JSON.stringify(snapshot)).not.toContain(other.id)
  })

  it('ranks whole-word Unicode matches by distinct shared words with a stable tie order', () => {
    const { db, project, session, working, longTerm } = setup()
    working.create({ projectId: project.id, category: 'note', key: 'zeta', value: 'SQLITE учёт' })
    working.create({ projectId: project.id, category: 'note', key: 'alpha', value: 'SQLite SQLite' })
    working.create({ projectId: project.id, category: 'note', key: 'beta', value: 'SQLite' })
    working.create({ projectId: project.id, category: 'note', key: 'substring', value: 'SQLitebackup' })
    working.create({ projectId: project.id, category: 'note', key: 'stopword', value: 'что это the' })
    longTerm.create({ category: 'decision', key: 'engine', value: 'SQLite', projectIds: [project.id] })
    const snapshot = createMemorySnapshot(db, session.id, message('Что это: sqlite, УЧЕТ?'))

    expect(snapshot.workingEntries.map(entry => entry.key)).toEqual(['zeta', 'alpha', 'beta'])
    expect(snapshot.longTermFacts.map(entry => entry.key)).toEqual(['engine'])
    expect(previewMemory(db, project.id, 'Что это: sqlite, УЧЕТ?').working.estimatedTokens).toBe(snapshot.preview.working.estimatedTokens)
  })

  it('does not select unrelated notes through common Russian or English prepositions', () => {
    const { db, project, session, working } = setup()
    working.create({ projectId: project.id, category: 'note', key: 'server', value: 'на сервере in production' })
    expect(createMemorySnapshot(db, session.id, message('на кухне in kitchen')).workingEntries).toEqual([])
  })

  it('matches words with combining marks and ignores single Unicode characters', () => {
    const { db, project, session, working } = setup()
    working.create({ projectId: project.id, category: 'note', key: 'book', value: 'किताब' })
    working.create({ projectId: project.id, category: 'note', key: 'single', value: '𠀀' })
    expect(createMemorySnapshot(db, session.id, message('किताब 𠀀')).workingEntries.map(entry => entry.key)).toEqual(['book'])
  })

  it('fills independent budgets with complete records after required entries and skips oversized matches', () => {
    const { db, project, session, working, longTerm } = setup()
    const required = working.create({ projectId: project.id, category: 'goal', key: 'goal', value: 'ship' })
    const oversized = working.create({ projectId: project.id, category: 'note', key: 'a', value: `sqlite rollout ${'x'.repeat(4_000)}` })
    const small = working.create({ projectId: project.id, category: 'note', key: 'b', value: 'sqlite' })
    longTerm.create({ category: 'profile', key: 'language', value: 'Russian', global: true })
    longTerm.create({ category: 'knowledge', key: 'engine', value: 'sqlite', global: true })
    createMemorySettingsRepository(db).update({ workingTokens: 220, longTermTokens: 300, expectedRevision: 0 })

    const snapshot = createMemorySnapshot(db, session.id, message('sqlite rollout'))
    expect(() => assertMemoryBudgets(snapshot)).not.toThrow()
    expect(snapshot.workingEntries.map(entry => entry.id)).toEqual([required.id, small.id])
    expect(snapshot.preview.working.estimatedTokens).toBeLessThanOrEqual(220)
    expect(snapshot.preview.longTerm.estimatedTokens).toBeLessThanOrEqual(300)
    expect(snapshot.longTermFacts).toHaveLength(2)
    expect(snapshot.preview.exclusions).toContainEqual({ id: oversized.id, revision: 0, layer: 'working', reason: 'budget_exceeded' })
    expect(snapshot.messages[0]?.parts).toEqual([expect.objectContaining({ text: expect.stringContaining('- [note] b (') })])
    expect(JSON.stringify(snapshot.messages)).not.toContain(oversized.value)
  })

  it('counts JSON escapes and block overhead at the exact budget boundary', () => {
    const { db, project, session, working } = setup()
    working.create({ projectId: project.id, category: 'goal', key: 'goal', value: 'ship' })
    working.create({ projectId: project.id, category: 'note', key: 'escaped', value: `sqlite ${'"\\\n'.repeat(30)}` })
    const current = message('sqlite')
    const full = createMemorySnapshot(db, session.id, current)
    const block = full.messages[0]!
    const exactBudget = Math.ceil(Buffer.byteLength(JSON.stringify({ role: block.role, parts: block.parts }), 'utf8') / 2)
    const settings = createMemorySettingsRepository(db)
    settings.update({ workingTokens: exactBudget, expectedRevision: 0 })
    expect(createMemorySnapshot(db, session.id, current).workingEntries.map(entry => entry.key)).toEqual(['goal', 'escaped'])
    settings.update({ workingTokens: exactBudget - 1, expectedRevision: 1 })
    expect(createMemorySnapshot(db, session.id, current).workingEntries.map(entry => entry.key)).toEqual(['goal'])
  })

  it('uses only three preceding completed user messages from the same dialogue for follow-up questions', () => {
    const { db, project, session, working } = setup()
    const sibling = createSessionRepository(db).createSession({ projectId: project.id })
    for (const word of ['obsolete', 'sqlite', 'assistantword', 'partialword', 'siblingword']) working.create({ projectId: project.id, category: 'note', key: word, value: word })
    const insert = db.prepare(`INSERT INTO messages (id, session_id, position, role, status, payload_json, storage_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`)
    const texts = ['obsolete', 'sqlite', 'second', 'third', 'assistantword', 'partialword']
    const history: ChatUIMessage[] = []
    for (const [position, text] of texts.entries()) {
      const item = message(text)
      if (position === 4) item.role = 'assistant'
      insert.run(item.id, session.id, position, item.role, position === 5 ? 'partial' : 'complete', JSON.stringify(item))
      history.push(item)
    }
    const other = message('siblingword')
    insert.run(other.id, sibling.id, 0, 'user', 'complete', JSON.stringify(other))

    expect(createMemorySnapshot(db, session.id, message('а почему?')).workingEntries.map(entry => entry.key)).toEqual(['sqlite'])
    // A retried current message is already stored and must not consume one of the three preceding slots.
    expect(createMemorySnapshot(db, session.id, history[3]).workingEntries.map(entry => entry.key)).toEqual(['obsolete', 'sqlite'])
  })

  it('selects matching notes from the incoming message before saving the new turn', () => {
    const { db, project, session, working } = setup()
    const entry = working.create({ projectId: project.id, category: 'note', key: 'database', value: 'SQLite' })
    working.create({ projectId: project.id, category: 'note', key: 'unrelated', value: 'Vercel' })
    const current = message('SQLite')
    const started = startMemoryAwareTurn(db, { request: { kind: 'message', requestId: randomUUID(), sessionId: session.id, message: current }, modelId: 'mock', agentConfig: {} })
    expect(started.snapshot.workingEntries.map(item => item.id)).toEqual([entry.id])
    expect(db.prepare('SELECT id FROM messages WHERE id = ?').get(current.id)).toEqual({ id: current.id })
  })

  it('rejects required profile overflow before storing a turn', () => {
    const { db, session, longTerm } = setup()
    longTerm.create({ category: 'profile', key: 'preferences', value: 'x'.repeat(2_000), global: true })
    createMemorySettingsRepository(db).update({ longTermTokens: 100, expectedRevision: 0 })
    expect(() => startMemoryAwareTurn(db, { request: { kind: 'message', requestId: randomUUID(), sessionId: session.id, message: message('continue') }, modelId: 'mock', agentConfig: {} })).toThrow(expect.objectContaining({ code: 'MEMORY_BUDGET_EXCEEDED' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({ count: 0 })
  })
})
