import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  CreateWorkingEntry,
  MemoryListQuery,
  MemoryPage,
  MemoryUpsertResult,
  UpsertWorkingEntry,
  UpdateWorkingEntry,
  WorkingMemoryCategory,
  WorkingMemoryEntry,
} from '../../shared/memory'
import { recordMemoryChange } from './change-log'
import { MemoryError } from './errors'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100
const CATEGORIES: ReadonlySet<WorkingMemoryCategory> = new Set(['goal', 'constraint', 'state', 'result', 'note'])
const OVERWRITE_CATEGORIES: ReadonlySet<WorkingMemoryCategory> = new Set(['goal', 'constraint', 'state'])
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

function validateKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length < 1 || key.trim().length > MAX_KEY_LENGTH) {
    throw new MemoryError('INVALID_INPUT', `key must be 1 to ${MAX_KEY_LENGTH} characters`)
  }
  return key.trim()
}

function validateText(key: string, value: string): { key: string; value: string } {
  const normalizedKey = validateKey(key)
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_VALUE_LENGTH) {
    throw new MemoryError('INVALID_INPUT', `value must be 1 to ${MAX_VALUE_LENGTH} characters`)
  }
  return { key: normalizedKey, value }
}

function validateCategory(category: string): asserts category is WorkingMemoryCategory {
  if (!CATEGORIES.has(category as WorkingMemoryCategory)) throw new MemoryError('INVALID_INPUT', 'invalid working memory category')
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new MemoryError('INVALID_INPUT', 'expectedRevision must be a non-negative integer')
}

function normalizeKey(key: string): string {
  return key.trim().toLocaleLowerCase()
}

function validateTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(timestamp))) throw new MemoryError('INVALID_INPUT', 'recordedAt must be a valid timestamp')
  return timestamp
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
  const selectById = (id: string): WorkingRow | undefined => db.prepare(`
    SELECT id, project_id, category, memory_key, value, enabled,
           source_session_id, source_message_id, revision, created_at, updated_at
    FROM working_memory_entries WHERE id = ?
  `).get(id) as WorkingRow | undefined

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

  function createInternal(input: CreateWorkingEntry, timestamp: string): WorkingMemoryEntry {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO working_memory_entries
        (id, project_id, category, memory_key, value, enabled, source_session_id, source_message_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.projectId, input.category, input.key, input.value, input.enabled === false ? 0 : 1, input.sourceSessionId ?? null, input.sourceMessageId ?? null, timestamp, timestamp)
    return toEntry(selectById(id)!)
  }

  function create(input: CreateWorkingEntry): WorkingMemoryEntry {
    validateCategory(input.category)
    const { key, value } = validateText(input.key, input.value)
    assertProject(input.projectId)
    validateSource(db, input.sourceSessionId, input.sourceMessageId, input.projectId)
    return createInternal({ ...input, key, value }, new Date().toISOString())
  }

  function upsert(input: UpsertWorkingEntry): MemoryUpsertResult<WorkingMemoryEntry> {
    validateCategory(input.category)
    const { key, value } = validateText(input.key, input.value)
    assertProject(input.projectId)
    validateSource(db, input.sourceSessionId, input.sourceMessageId, input.projectId)
    const timestamp = validateTimestamp(input.recordedAt)
    return db.transaction(() => {
      if (!OVERWRITE_CATEGORIES.has(input.category)) {
        return { status: 'appended' as const, entry: createInternal({ ...input, key, value }, timestamp) }
      }

      const rows = db.prepare(`
        SELECT id, project_id, category, memory_key, value, enabled,
               source_session_id, source_message_id, revision, created_at, updated_at
        FROM working_memory_entries WHERE project_id = ?
      `).all(input.projectId) as WorkingRow[]
      const current = rows.find(row => normalizeKey(row.memory_key) === normalizeKey(key))
      if (!current) return { status: 'created' as const, entry: createInternal({ ...input, key, value }, timestamp) }
      if (Date.parse(current.updated_at) > Date.parse(timestamp)) {
        return { status: 'stale' as const, entry: toEntry(current) }
      }

      const result = db.prepare(`
        UPDATE working_memory_entries
        SET category = ?, memory_key = ?, value = ?, enabled = ?, source_session_id = ?, source_message_id = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(input.category, key, value, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, input.sourceSessionId ?? null, input.sourceMessageId ?? null, timestamp, current.id, current.revision)
      if (result.changes !== 1) throw new MemoryError('REVISION_CONFLICT', 'working memory entry was changed by another request')
      if (current.value !== value) {
        recordMemoryChange(db, {
          id: randomUUID(),
          layer: 'working',
          entryId: current.id,
          projectId: current.project_id,
          category: input.category,
          memoryKey: key,
          action: 'replace',
          oldValue: current.value,
          newValue: value,
          ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
          changedAt: timestamp,
        })
      }
      return { status: 'replaced' as const, entry: toEntry(selectById(current.id)!), previousValue: current.value }
    }).immediate()
  }

  function update(id: string, patch: UpdateWorkingEntry): WorkingMemoryEntry {
    validateRevision(patch.expectedRevision)
    if (patch.category !== undefined) validateCategory(patch.category)
    const current = selectById(id)
    if (!current) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
    const category = patch.category ?? current.category
    const key = patch.key === undefined ? current.memory_key : validateKey(patch.key)
    const value = patch.value === undefined ? current.value : validateText(key, patch.value).value
    const timestamp = new Date().toISOString()
    return db.transaction(() => {
      const result = db.prepare(`
        UPDATE working_memory_entries
        SET category = ?, memory_key = ?, value = ?, enabled = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(category, key, value, patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0, timestamp, id, patch.expectedRevision)
      if (result.changes !== 1) {
        if (!selectById(id)) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
        throw new MemoryError('REVISION_CONFLICT', 'working memory entry was changed by another request')
      }
      if (current.value !== value) {
        recordMemoryChange(db, {
          id: randomUUID(),
          layer: 'working',
          entryId: id,
          projectId: current.project_id,
          category,
          memoryKey: key,
          action: 'replace',
          oldValue: current.value,
          newValue: value,
          ...(current.source_session_id === null ? {} : { sourceSessionId: current.source_session_id }),
          changedAt: timestamp,
        })
      }
      return toEntry(selectById(id)!)
    }).immediate()
  }

  function remove(id: string): void {
    db.transaction(() => {
      const current = selectById(id)
      if (!current) throw new MemoryError('NOT_FOUND', 'working memory entry was not found')
      db.prepare('DELETE FROM working_memory_entries WHERE id = ?').run(id)
      recordMemoryChange(db, {
        id: randomUUID(),
        layer: 'working',
        entryId: id,
        projectId: current.project_id,
        category: current.category,
        memoryKey: current.memory_key,
        action: 'forget',
        oldValue: current.value,
        ...(current.source_session_id === null ? {} : { sourceSessionId: current.source_session_id }),
        changedAt: new Date().toISOString(),
      })
    }).immediate()
  }

  function forgetByKey(projectId: string, key: string): string[] {
    assertProject(projectId)
    const normalized = normalizeKey(validateKey(key))
    const rows = db.prepare(`
      SELECT id, project_id, category, memory_key, value, enabled,
             source_session_id, source_message_id, revision, created_at, updated_at
      FROM working_memory_entries WHERE project_id = ?
    `).all(projectId) as WorkingRow[]
    const matches = rows.filter(row => normalizeKey(row.memory_key) === normalized)
    for (const row of matches) remove(row.id)
    return matches.map(row => row.value)
  }

  function clear(projectId: string): number {
    assertProject(projectId)
    const result = db.prepare('DELETE FROM working_memory_entries WHERE project_id = ?').run(projectId)
    return result.changes
  }

  function clearForFinishedTask(projectId: string, sessionId: string): number {
    assertProject(projectId)
    const clear = () => {
      const rows = db.prepare(`
        SELECT id, project_id, category, memory_key, value, enabled,
               source_session_id, source_message_id, revision, created_at, updated_at
        FROM working_memory_entries WHERE project_id = ?
      `).all(projectId) as WorkingRow[]
      const changedAt = new Date().toISOString()
      for (const row of rows) {
        recordMemoryChange(db, {
          id: randomUUID(),
          layer: 'working',
          entryId: row.id,
          projectId,
          category: row.category,
          memoryKey: row.memory_key,
          action: 'task_cleanup',
          oldValue: row.value,
          sourceSessionId: sessionId,
          changedAt,
        })
      }
      db.prepare('DELETE FROM working_memory_entries WHERE project_id = ?').run(projectId)
      return rows.length
    }
    return db.inTransaction ? clear() : db.transaction(clear).immediate()
  }

  return { list, create, update, remove, upsert, forgetByKey, clear, clearForFinishedTask }
}
