import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  CreateWorkingEntry,
  MemoryListQuery,
  MemoryPage,
  UpdateWorkingEntry,
  WorkingMemoryCategory,
  WorkingMemoryEntry,
} from '../../shared/memory'
import { MemoryError } from './errors'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100
const CATEGORIES: ReadonlySet<WorkingMemoryCategory> = new Set(['goal', 'constraint', 'state', 'result', 'note'])
const MAX_KEY_LENGTH = 80
const MAX_VALUE_LENGTH = 10_000

interface WorkingRow {
  id: string
  project_id: string
  category: WorkingMemoryCategory
  memory_key: string
  value: string
  enabled: number
  source_session_id: string | null
  source_message_id: string | null
  revision: number
  created_at: string
  updated_at: string
}

function toEntry(row: WorkingRow): WorkingMemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    category: row.category,
    key: row.memory_key,
    value: row.value,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    ...(row.source_message_id === null ? {} : { sourceMessageId: row.source_message_id }),
  }
}

function validateText(key: string, value: string): { key: string; value: string } {
  if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > MAX_KEY_LENGTH) {
    throw new MemoryError('INVALID_INPUT', `key must be 1 to ${MAX_KEY_LENGTH} characters`)
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_VALUE_LENGTH) {
    throw new MemoryError('INVALID_INPUT', `value must be 1 to ${MAX_VALUE_LENGTH} characters`)
  }
  return { key: key.trim(), value }
}

function validateCategory(category: string): asserts category is WorkingMemoryCategory {
  if (!CATEGORIES.has(category as WorkingMemoryCategory)) throw new MemoryError('INVALID_INPUT', 'invalid working memory category')
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

function encodeCursor(row: WorkingRow): string {
  return Buffer.from(JSON.stringify({ category: row.category, key: row.memory_key, id: row.id }), 'utf8').toString('base64url')
}

function validateSource(db: Database.Database, sourceSessionId: string | undefined, sourceMessageId: string | undefined, projectId: string): void {
  if (sourceMessageId !== undefined && sourceSessionId === undefined) {
    throw new MemoryError('INVALID_INPUT', 'sourceSessionId is required with sourceMessageId')
  }
  if (sourceSessionId === undefined) return
  const session = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sourceSessionId) as { project_id: string | null } | undefined
  if (!session) throw new MemoryError('NOT_FOUND', 'source session was not found')
  if (session.project_id !== projectId) throw new MemoryError('INVALID_INPUT', 'source session must belong to the project')
  if (sourceMessageId !== undefined) {
    const message = db.prepare('SELECT session_id FROM messages WHERE id = ?').get(sourceMessageId) as { session_id: string } | undefined
    if (!message) throw new MemoryError('NOT_FOUND', 'source message was not found')
    if (message.session_id !== sourceSessionId) throw new MemoryError('INVALID_INPUT', 'source message belongs to another session')
  }
}

export function createWorkingMemoryRepository(db: Database.Database) {
  function assertProject(projectId: string): void {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MemoryError('NOT_FOUND', 'project was not found')
  }

  function list(projectId: string, query: MemoryListQuery = {}): MemoryPage<WorkingMemoryEntry> {
    assertProject(projectId)
    if (query.category !== undefined) validateCategory(query.category)
    const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)
    const cursor = decodeCursor(query.cursor)
    const conditions = ['project_id = ?']
    const params: Array<string | number> = [projectId]
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
      SELECT id, project_id, category, memory_key, value, enabled,
             source_session_id, source_message_id, revision, created_at, updated_at
      FROM working_memory_entries
      WHERE ${conditions.join(' AND ')}
      ORDER BY category ASC, memory_key ASC, id ASC
      LIMIT ?
    `).all(...params, limit + 1) as WorkingRow[]
    const page = rows.length > limit ? rows.slice(0, limit) : rows
    return {
      items: page.map(toEntry),
      ...(rows.length > limit && page.at(-1) ? { nextCursor: encodeCursor(page.at(-1)!) } : {}),
    }
  }

  function create(input: CreateWorkingEntry): WorkingMemoryEntry {
    validateCategory(input.category)
    const { key, value } = validateText(input.key, input.value)
    assertProject(input.projectId)
    validateSource(db, input.sourceSessionId, input.sourceMessageId, input.projectId)
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`
      INSERT INTO working_memory_entries
        (id, project_id, category, memory_key, value, enabled, source_session_id, source_message_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.projectId, input.category, key, value, input.enabled === false ? 0 : 1, input.sourceSessionId ?? null, input.sourceMessageId ?? null, timestamp, timestamp)
    return toEntry(db.prepare('SELECT id, project_id, category, memory_key, value, enabled, source_session_id, source_message_id, revision, created_at, updated_at FROM working_memory_entries WHERE id = ?').get(id) as WorkingRow)
  }

  function update(id: string, patch: UpdateWorkingEntry): WorkingMemoryEntry {
    validateRevision(patch.expectedRevision)
    if (patch.category !== undefined) validateCategory(patch.category)
    if (patch.key !== undefined || patch.value !== undefined) {
      const current = db.prepare('SELECT memory_key, value FROM working_memory_entries WHERE id = ?').get(id) as { memory_key: string; value: string } | undefined
      if (!current) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
      validateText(patch.key ?? current.memory_key, patch.value ?? current.value)
    }
    const current = db.prepare('SELECT category, memory_key, value, enabled FROM working_memory_entries WHERE id = ?').get(id) as { category: WorkingMemoryCategory; memory_key: string; value: string; enabled: number } | undefined
    if (!current) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
    const category = patch.category ?? current.category
    const key = patch.key === undefined ? current.memory_key : validateText(patch.key, patch.value ?? current.value).key
    const value = patch.value === undefined ? current.value : validateText(patch.key ?? current.memory_key, patch.value).value
    const result = db.prepare(`
      UPDATE working_memory_entries
      SET category = ?, memory_key = ?, value = ?, enabled = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(category, key, value, patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0, new Date().toISOString(), id, patch.expectedRevision)
    if (result.changes !== 1) {
      if (!db.prepare('SELECT 1 FROM working_memory_entries WHERE id = ?').get(id)) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
      throw new MemoryError('REVISION_CONFLICT', 'working memory entry was changed by another request')
    }
    return toEntry(db.prepare('SELECT id, project_id, category, memory_key, value, enabled, source_session_id, source_message_id, revision, created_at, updated_at FROM working_memory_entries WHERE id = ?').get(id) as WorkingRow)
  }

  function remove(id: string): void {
    const result = db.prepare('DELETE FROM working_memory_entries WHERE id = ?').run(id)
    if (result.changes === 0) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
  }

  function clear(projectId: string): number {
    assertProject(projectId)
    const result = db.prepare('DELETE FROM working_memory_entries WHERE project_id = ?').run(projectId)
    return result.changes
  }

  return { list, create, update, remove, clear }
}
