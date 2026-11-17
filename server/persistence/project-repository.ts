import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MemoryError } from '../memory/errors'
import type { MemoryListQuery, MemoryPage, Project } from '../../shared/memory'

const DEFAULT_PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100

interface ProjectRow {
  id: string
  name: string
  revision: number
  created_at: string
  updated_at: string
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeName(name: string): string {
  const value = name.trim()
  if (value.length < 1 || value.length > 120) throw new MemoryError('INVALID_INPUT', 'project name must be 1 to 120 characters')
  return value
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!cursor) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown }
    if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') throw new Error('invalid cursor')
    return { updatedAt: parsed.updatedAt, id: parsed.id }
  } catch {
    throw new MemoryError('INVALID_INPUT', 'project cursor is invalid')
  }
}

function encodeCursor(row: ProjectRow): string {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id }), 'utf8').toString('base64url')
}

export function createProjectRepository(db: Database.Database) {
  function create(name: string): Project {
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    const value = normalizeName(name)
    db.prepare(`
      INSERT INTO projects (id, name, revision, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(id, value, timestamp, timestamp)
    return { id, name: value, revision: 0, createdAt: timestamp, updatedAt: timestamp }
  }

  function list(query: MemoryListQuery = {}): MemoryPage<Project> {
    const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE)
    const cursor = decodeCursor(query.cursor)
    const text = query.text?.trim()
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (text) {
      conditions.push('name LIKE ? ESCAPE \'\\\'')
      params.push(`%${text.replace(/[\\%_]/gu, '\\$&')}%`)
    }
    if (cursor) {
      conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = db.prepare(`
      SELECT id, name, revision, created_at, updated_at
      FROM projects
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit + 1) as ProjectRow[]
    const page = rows.length > limit ? rows.slice(0, limit) : rows
    return {
      items: page.map(toProject),
      ...(rows.length > limit && page.at(-1) ? { nextCursor: encodeCursor(page.at(-1)!) } : {}),
    }
  }

  function rename(id: string, name: string, expectedRevision: number): Project {
    const value = normalizeName(name)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new MemoryError('INVALID_INPUT', 'expectedRevision must be a non-negative integer')
    const result = db.prepare(`
      UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(value, new Date().toISOString(), id, expectedRevision)
    if (result.changes === 0) {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) throw new MemoryError('NOT_FOUND', 'project was not found')
      throw new MemoryError('REVISION_CONFLICT', 'project was changed by another request')
    }
    return toProject(db.prepare('SELECT id, name, revision, created_at, updated_at FROM projects WHERE id = ?').get(id) as ProjectRow)
  }

  function assignSession(sessionId: string, projectId: string): void {
    const transaction = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new MemoryError('NOT_FOUND', 'project was not found')
      const session = db.prepare('SELECT project_id, status FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null; status: string } | undefined
      if (!session) throw new MemoryError('NOT_FOUND', 'session was not found')
      if (session.project_id !== null) throw new MemoryError('PROJECT_ALREADY_ASSIGNED', 'session already belongs to a project')
      if (session.status === 'running' || db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
        throw new MemoryError('SESSION_RUNNING', 'session is running')
      }
      if (db.prepare("SELECT 1 FROM history_clear_operations WHERE session_id = ? AND status = 'pending_files'").get(sessionId)) {
        throw new MemoryError('HISTORY_CLEAR_PENDING', 'session history cleanup is pending')
      }
      const result = db.prepare('UPDATE sessions SET project_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND project_id IS NULL')
        .run(projectId, new Date().toISOString(), sessionId)
      if (result.changes !== 1) throw new MemoryError('PROJECT_ALREADY_ASSIGNED', 'session already belongs to a project')
    })
    transaction.immediate()
  }

  return { create, list, rename, assignSession }
}
