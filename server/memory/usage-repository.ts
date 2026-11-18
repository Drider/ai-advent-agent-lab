import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MemorySelectionRef, MemorySnapshot, MemoryUsageEvent, MemoryUsageNumbers } from '../../shared/memory'

interface UsageRow {
  id: string
  snapshot_id: string
  session_id: string | null
  project_id: string | null
  turn_id: string | null
  prepared_at: string
  context_cleared: number
  short_term_count: number
  short_term_bytes: number
  short_term_tokens: number
  working_count: number
  working_bytes: number
  working_tokens: number
  long_term_count: number
  long_term_bytes: number
  long_term_tokens: number
  working_refs_json: string
  long_term_refs_json: string
  exclusions_json: string
}

function numbers(count: number, bytes: number, estimatedTokens: number): MemoryUsageNumbers {
  return { count, bytes, estimatedTokens }
}

function toEvent(row: UsageRow): MemoryUsageEvent {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    sessionId: row.session_id ?? '',
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    preparedAt: row.prepared_at,
    contextCleared: row.context_cleared === 1,
    shortTerm: numbers(row.short_term_count, row.short_term_bytes, row.short_term_tokens),
    working: numbers(row.working_count, row.working_bytes, row.working_tokens),
    longTerm: numbers(row.long_term_count, row.long_term_bytes, row.long_term_tokens),
    workingRefs: JSON.parse(row.working_refs_json) as MemorySelectionRef[],
    longTermRefs: JSON.parse(row.long_term_refs_json) as MemorySelectionRef[],
    exclusions: JSON.parse(row.exclusions_json),
  }
}

export function createMemoryUsageRepository(db: Database.Database) {
  function findBySnapshot(snapshotId: string): MemoryUsageEvent | undefined {
    const row = db.prepare('SELECT * FROM memory_usage_events WHERE snapshot_id = ?').get(snapshotId) as UsageRow | undefined
    return row === undefined ? undefined : toEvent(row)
  }

  function recordPrepared(input: {
    turnId: string
    snapshot: MemorySnapshot
    shortTerm: MemoryUsageNumbers
    requireTurn?: boolean
  }): MemoryUsageEvent {
    const existing = findBySnapshot(input.snapshot.id)
    if (existing) return existing
    const now = Date.now()
    const previous = db.prepare('SELECT MAX(prepared_at) AS prepared_at FROM memory_usage_events').get() as { prepared_at: string | null }
    const previousMs = previous.prepared_at === null ? 0 : Date.parse(previous.prepared_at)
    const timestamp = new Date(Math.max(now, previousMs + 1)).toISOString()
    const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(input.snapshot.sessionId)
    if (!sessionExists) throw new Error('session was not found')
    const turnExists = db.prepare('SELECT 1 FROM turns WHERE id = ?').get(input.turnId)
    if (!turnExists && input.requireTurn === true) throw new Error('turn no longer exists')
    db.prepare(`
      INSERT INTO memory_usage_events
        (id, snapshot_id, session_id, project_id, turn_id, prepared_at, context_cleared,
         short_term_count, short_term_bytes, short_term_tokens,
         working_count, working_bytes, working_tokens,
         long_term_count, long_term_bytes, long_term_tokens,
         working_refs_json, long_term_refs_json, exclusions_json)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.snapshot.id,
      input.snapshot.sessionId,
      input.snapshot.projectId ?? null,
      turnExists ? input.turnId : null,
      timestamp,
      input.shortTerm.count,
      input.shortTerm.bytes,
      input.shortTerm.estimatedTokens,
      input.snapshot.preview.working.count,
      input.snapshot.preview.working.bytes,
      input.snapshot.preview.working.estimatedTokens,
      input.snapshot.preview.longTerm.count,
      input.snapshot.preview.longTerm.bytes,
      input.snapshot.preview.longTerm.estimatedTokens,
      JSON.stringify(input.snapshot.workingRefs),
      JSON.stringify(input.snapshot.longTermRefs),
      JSON.stringify(input.snapshot.preview.exclusions),
    )
    return findBySnapshot(input.snapshot.id)!
  }

  function markSessionContextCleared(sessionId: string): void {
    db.prepare('UPDATE memory_usage_events SET context_cleared = 1 WHERE session_id = ?').run(sessionId)
  }

  return { recordPrepared, markSessionContextCleared }
}

export function readMemoryUsageEvent(db: Database.Database, id: string): MemoryUsageEvent | undefined {
  const row = db.prepare('SELECT * FROM memory_usage_events WHERE id = ?').get(id) as UsageRow | undefined
  return row === undefined ? undefined : toEvent(row)
}
