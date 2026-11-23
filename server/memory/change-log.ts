import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MemoryChange } from '../../shared/memory'

interface MemoryChangeRow {
  id: string
  layer: MemoryChange['layer']
  entry_id: string
  project_id: string | null
  category: MemoryChange['category']
  memory_key: string
  action: MemoryChange['action']
  old_value: string
  new_value: string | null
  source_session_id: string | null
  changed_at: string
}

function toMemoryChange(row: MemoryChangeRow): MemoryChange {
  return {
    id: row.id,
    layer: row.layer,
    entryId: row.entry_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    category: row.category,
    memoryKey: row.memory_key,
    action: row.action,
    oldValue: row.old_value,
    ...(row.new_value === null ? {} : { newValue: row.new_value }),
    ...(row.source_session_id === null ? {} : { sourceSessionId: row.source_session_id }),
    changedAt: row.changed_at,
  }
}

export function recordMemoryChange(db: Database.Database, change: MemoryChange): void {
  db.prepare(`
    INSERT INTO memory_changes
      (id, layer, entry_id, project_id, category, memory_key, action, old_value, new_value, source_session_id, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    change.id || randomUUID(),
    change.layer,
    change.entryId,
    change.projectId ?? null,
    change.category,
    change.memoryKey,
    change.action,
    change.oldValue,
    change.newValue ?? null,
    change.sourceSessionId ?? null,
    change.changedAt,
  )
}

export function listMemoryChanges(
  db: Database.Database,
  query: { projectId?: string; limit: number },
): MemoryChange[] {
  const limit = Math.min(Math.max(Math.floor(query.limit), 1), 100)
  const rows = query.projectId === undefined
    ? db.prepare(`
        SELECT id, layer, entry_id, project_id, category, memory_key, action,
               old_value, new_value, source_session_id, changed_at
        FROM memory_changes
        ORDER BY changed_at DESC, id DESC
        LIMIT ?
      `).all(limit) as MemoryChangeRow[]
    : db.prepare(`
        SELECT id, layer, entry_id, project_id, category, memory_key, action,
               old_value, new_value, source_session_id, changed_at
        FROM memory_changes
        WHERE project_id = ? OR (layer = 'long_term' AND project_id IS NULL)
        ORDER BY changed_at DESC, id DESC
        LIMIT ?
      `).all(query.projectId, limit) as MemoryChangeRow[]
  return rows.map(toMemoryChange)
}
