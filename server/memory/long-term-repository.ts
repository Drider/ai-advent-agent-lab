import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  CreateLongTermFact,
  LongTermFact,
  LongTermMemoryCategory,
  MemoryListQuery,
  MemoryPage,
  UpdateLongTermFact,
} from '../../shared/memory'
import { MemoryError } from './errors'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100
const CATEGORIES: ReadonlySet<LongTermMemoryCategory> = new Set(['profile', 'decision', 'knowledge'])
const MAX_KEY_LENGTH = 80
const MAX_VALUE_LENGTH = 10_000

interface FactRow {
  id: string
  category: LongTermMemoryCategory
  memory_key: string
  value: string
  enabled: number
  global_enabled: number
  source_session_id: string | null
  source_message_id: string | null
  revision: number
  created_at: string
  updated_at: string
}

function validateText(key: string, value: string): { key: string; value: string } {
  if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > MAX_KEY_LENGTH) throw new MemoryError('INVALID_INPUT', `key must be 1 to ${MAX_KEY_LENGTH} characters`)
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_VALUE_LENGTH) throw new MemoryError('INVALID_INPUT', `value must be 1 to ${MAX_VALUE_LENGTH} characters`)
  return { key: key.trim(), value }
}

function validateCategory(category: string): asserts category is LongTermMemoryCategory {
  if (!CATEGORIES.has(category as LongTermMemoryCategory)) throw new MemoryError('INVALID_INPUT', 'invalid long-term memory category')
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new MemoryError('INVALID_INPUT', 'expectedRevision must be a non-negative integer')
}

function decodeCursor(cursor: string | undefined): { category: string; key: string; id: string } | undefined {
  if (!cursor) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { category?: unknown; key?: unknown; id?: unknown }
    if (typeof parsed.category !== 'string' || typeof parsed.key !== 'string' || typeof parsed.id !== 'string') throw new Error('invalid cursor')
    return { category: parsed.category, key: parsed.key, id: parsed.id }
  } catch {
    throw new MemoryError('INVALID_INPUT', 'memory cursor is invalid')
  }
}

function encodeCursor(row: FactRow): string {
  return Buffer.from(JSON.stringify({ category: row.category, key: row.memory_key, id: row.id }), 'utf8').toString('base64url')
}

function validateSource(db: Database.Database, sourceSessionId: string | undefined, sourceMessageId: string | undefined): void {
  if (sourceMessageId !== undefined && sourceSessionId === undefined) throw new MemoryError('INVALID_INPUT', 'sourceSessionId is required with sourceMessageId')
  if (sourceSessionId === undefined) return
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sourceSessionId)) throw new MemoryError('NOT_FOUND', 'source session was not found')
  if (sourceMessageId !== undefined) {
    const message = db.prepare('SELECT session_id FROM messages WHERE id = ?').get(sourceMessageId) as { session_id: string } | undefined
    if (!message) throw new MemoryError('NOT_FOUND', 'source message was not found')
    if (message.session_id !== sourceSessionId) throw new MemoryError('INVALID_INPUT', 'source message belongs to another session')
  }
}

function validateProjectIds(db: Database.Database, projectIds: string[]): string[] {
  const unique = [...new Set(projectIds)]
  for (const projectId of unique) {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MemoryError('NOT_FOUND', 'project was not found')
  }
  return unique
}

export function createLongTermMemoryRepository(db: Database.Database) {
  function toFact(row: FactRow): LongTermFact {
    const projectIds = (db.prepare('SELECT project_id FROM project_long_term_facts WHERE fact_id = ? ORDER BY project_id ASC').all(row.id) as Array<{ project_id: string }>).map(item => item.project_id)
    return {
      id: row.id,
      category: row.category,
      key: row.memory_key,
      value: row.value,
      enabled: row.enabled === 1,
      global: row.global_enabled === 1,
      projectIds,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
      ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
    }
  }

  function list(query: MemoryListQuery & { projectId?: string } = {}): MemoryPage<LongTermFact> {
    if (query.category !== undefined) validateCategory(query.category)
    const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)
    const cursor = decodeCursor(query.cursor)
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (query.projectId !== undefined) {
      conditions.push('(global_enabled = 1 OR EXISTS (SELECT 1 FROM project_long_term_facts AS link WHERE link.fact_id = long_term_facts.id AND link.project_id = ?))')
      params.push(query.projectId)
    }
    if (query.text?.trim()) {
      conditions.push('(memory_key LIKE ? ESCAPE \'\\\' OR value LIKE ? ESCAPE \'\\\')')
      const text = `%${query.text.trim().replace(/[\\%_]/gu, '\\$&')}%`
      params.push(text, text)
    }
    if (query.category !== undefined) {
      conditions.push('category = ?')
      params.push(query.category)
    }
    if (cursor) {
      conditions.push('(category > ? OR (category = ? AND (memory_key > ? OR (memory_key = ? AND id > ?))))')
      params.push(cursor.category, cursor.category, cursor.key, cursor.key, cursor.id)
    }
    const rows = db.prepare(`
      SELECT id, category, memory_key, value, enabled, global_enabled,
             source_session_id, source_message_id, revision, created_at, updated_at
      FROM long_term_facts
      ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
      ORDER BY category ASC, memory_key ASC, id ASC
      LIMIT ?
    `).all(...params, limit + 1) as FactRow[]
    const page = rows.length > limit ? rows.slice(0, limit) : rows
    return {
      items: page.map(toFact),
      ...(rows.length > limit && page.at(-1) ? { nextCursor: encodeCursor(page.at(-1)!) } : {}),
    }
  }

  function create(input: CreateLongTermFact): LongTermFact {
    validateCategory(input.category)
    const { key, value } = validateText(input.key, input.value)
    validateSource(db, input.sourceSessionId, input.sourceMessageId)
    const projectIds = validateProjectIds(db, input.projectIds ?? [])
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO long_term_facts
          (id, category, memory_key, value, enabled, global_enabled, source_session_id, source_message_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, input.category, key, value, input.enabled === false ? 0 : 1, input.global === true ? 1 : 0, input.sourceSessionId ?? null, input.sourceMessageId ?? null, timestamp, timestamp)
      const insertLink = db.prepare('INSERT INTO project_long_term_facts (fact_id, project_id, created_at) VALUES (?, ?, ?)')
      for (const projectId of projectIds) insertLink.run(id, projectId, timestamp)
    })
    transaction.immediate()
    return toFact(db.prepare('SELECT id, category, memory_key, value, enabled, global_enabled, source_session_id, source_message_id, revision, created_at, updated_at FROM long_term_facts WHERE id = ?').get(id) as FactRow)
  }

  function update(id: string, patch: UpdateLongTermFact): LongTermFact {
    validateRevision(patch.expectedRevision)
    const current = db.prepare('SELECT category, memory_key, value, enabled, global_enabled FROM long_term_facts WHERE id = ?').get(id) as { category: LongTermMemoryCategory; memory_key: string; value: string; enabled: number; global_enabled: number } | undefined
    if (!current) throw new MemoryError('NOT_FOUND', 'long-term fact was not found')
    if (patch.category !== undefined) validateCategory(patch.category)
    const text = validateText(patch.key ?? current.memory_key, patch.value ?? current.value)
    const projectIds = patch.projectIds === undefined ? undefined : validateProjectIds(db, patch.projectIds)
    const timestamp = new Date().toISOString()
    const transaction = db.transaction(() => {
      const result = db.prepare(`
        UPDATE long_term_facts
        SET category = ?, memory_key = ?, value = ?, enabled = ?, global_enabled = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(patch.category ?? current.category, text.key, text.value, patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0, patch.global === undefined ? current.global_enabled : patch.global ? 1 : 0, timestamp, id, patch.expectedRevision)
      if (result.changes !== 1) {
        if (!db.prepare('SELECT 1 FROM long_term_facts WHERE id = ?').get(id)) throw new MemoryError('NOT_FOUND', 'long-term fact was not found')
        throw new MemoryError('REVISION_CONFLICT', 'long-term fact was changed by another request')
      }
      if (projectIds !== undefined) {
        db.prepare('DELETE FROM project_long_term_facts WHERE fact_id = ?').run(id)
        const insertLink = db.prepare('INSERT INTO project_long_term_facts (fact_id, project_id, created_at) VALUES (?, ?, ?)')
        for (const projectId of projectIds) insertLink.run(id, projectId, timestamp)
      }
    })
    transaction.immediate()
    return toFact(db.prepare('SELECT id, category, memory_key, value, enabled, global_enabled, source_session_id, source_message_id, revision, created_at, updated_at FROM long_term_facts WHERE id = ?').get(id) as FactRow)
  }

  function remove(id: string): void {
    const result = db.prepare('DELETE FROM long_term_facts WHERE id = ?').run(id)
    if (result.changes === 0) throw new MemoryError('NOT_FOUND', 'long-term fact was not found')
  }

  function clear(): number {
    const result = db.prepare('DELETE FROM long_term_facts').run()
    return result.changes
  }

  function detachProject(projectId: string): number {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MemoryError('NOT_FOUND', 'project was not found')
    const timestamp = new Date().toISOString()
    const transaction = db.transaction(() => {
      const factIds = db.prepare('SELECT fact_id FROM project_long_term_facts WHERE project_id = ?').all(projectId) as Array<{ fact_id: string }>
      const result = db.prepare('DELETE FROM project_long_term_facts WHERE project_id = ?').run(projectId)
      const bump = db.prepare('UPDATE long_term_facts SET revision = revision + 1, updated_at = ? WHERE id = ?')
      for (const fact of factIds) bump.run(timestamp, fact.fact_id)
      return result.changes
    })
    return transaction.immediate()
  }

  return { list, create, update, remove, clear, detachProject }
}
