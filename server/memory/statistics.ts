import type Database from 'better-sqlite3'
import { MemoryError } from './errors'
import type { MemoryRecordUsage, MemoryScope, MemoryStatistics, MemoryStoredLayer, MemoryUsageEvent } from '../../shared/memory'

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

function layer(count: number, bytes: number, estimatedTokens: number, label: 'messages' | 'entries' | 'facts'): MemoryStoredLayer {
  return { count, bytes, estimatedTokens, [label]: count }
}

function sumLayer(db: Database.Database, table: string, where: string, params: string[], label: 'messages' | 'entries' | 'facts', bytesExpression: string): MemoryStoredLayer {
  const row = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${bytesExpression}), 0) AS bytes FROM ${table} WHERE ${where}`).get(...params) as { count: number; bytes: number }
  return layer(row.count, row.bytes, Math.ceil(row.bytes / 2), label)
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
    shortTerm: { count: row.short_term_count, bytes: row.short_term_bytes, estimatedTokens: row.short_term_tokens },
    working: { count: row.working_count, bytes: row.working_bytes, estimatedTokens: row.working_tokens },
    longTerm: { count: row.long_term_count, bytes: row.long_term_bytes, estimatedTokens: row.long_term_tokens },
    workingRefs: JSON.parse(row.working_refs_json),
    longTermRefs: JSON.parse(row.long_term_refs_json),
    exclusions: JSON.parse(row.exclusions_json),
  }
}

function storageFor(db: Database.Database, scope: MemoryScope): MemoryStatistics['stored'] {
  const projectId = scope.scope === 'project'
    ? scope.projectId
    : scope.scope === 'dialogue'
      ? (db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(scope.sessionId) as { project_id: string | null } | undefined)?.project_id ?? undefined
      : undefined
  let sessionWhere = '1 = 1'
  let sessionParams: string[] = []
  if (scope.scope === 'dialogue') {
    sessionWhere = 'session_id = ?'
    sessionParams = [scope.sessionId]
  } else if (scope.scope === 'project') {
    sessionWhere = 'session_id IN (SELECT id FROM sessions WHERE project_id = ?)'
    sessionParams = [scope.projectId]
  }
  const shortTerm = sumLayer(db, 'messages', sessionWhere, sessionParams, 'messages', 'length(CAST(payload_json AS BLOB))')
  const summary = db.prepare(`SELECT COUNT(*) AS count FROM context_checkpoints WHERE ${sessionWhere}`).get(...sessionParams) as { count: number }
  const sticky = db.prepare(`SELECT COUNT(*) AS count FROM facts_updates WHERE ${sessionWhere}`).get(...sessionParams) as { count: number }

  const working = projectId === undefined
    ? scope.scope === 'global'
      ? sumLayer(db, 'working_memory_entries', '1 = 1', [], 'entries', 'length(CAST(memory_key AS BLOB)) + length(CAST(value AS BLOB))')
      : layer(0, 0, 0, 'entries')
    : sumLayer(db, 'working_memory_entries', 'project_id = ?', [projectId], 'entries', 'length(CAST(memory_key AS BLOB)) + length(CAST(value AS BLOB))')

  const factWhere = scope.scope === 'global'
    ? '1 = 1'
    : scope.scope === 'project'
      ? '(global_enabled = 1 OR EXISTS (SELECT 1 FROM project_long_term_facts link WHERE link.fact_id = long_term_facts.id AND link.project_id = ?))'
      : 'global_enabled = 1 OR EXISTS (SELECT 1 FROM project_long_term_facts link JOIN sessions s ON s.project_id = link.project_id WHERE link.fact_id = long_term_facts.id AND s.id = ?)'
  const factParams = scope.scope === 'project' ? [scope.projectId] : scope.scope === 'dialogue' ? [scope.sessionId] : []
  const longTerm = sumLayer(db, 'long_term_facts', factWhere, factParams, 'facts', 'length(CAST(memory_key AS BLOB)) + length(CAST(value AS BLOB))')
  return { shortTerm, working, longTerm, summaries: summary.count, stickyFacts: sticky.count }
}

export function getMemoryStatistics(db: Database.Database, scope: MemoryScope): MemoryStatistics {
  if (scope.scope === 'dialogue' && !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(scope.sessionId)) throw new MemoryError('NOT_FOUND', 'session was not found')
  if (scope.scope === 'project' && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(scope.projectId)) throw new MemoryError('NOT_FOUND', 'project was not found')
  const filter = scope.scope === 'dialogue'
    ? { where: 'session_id = ?', params: [scope.sessionId] }
    : scope.scope === 'project'
      ? { where: 'project_id = ?', params: [scope.projectId] }
      : { where: '1 = 1', params: [] as string[] }
  const rows = db.prepare(`SELECT * FROM memory_usage_events WHERE ${filter.where} ORDER BY prepared_at ASC, id ASC`).all(...filter.params) as UsageRow[]
  const events = rows.map(toEvent)
  const recordMap = new Map<string, MemoryRecordUsage>()
  const revisions = new Map<string, number>()
  for (const row of db.prepare('SELECT id, revision FROM working_memory_entries').all() as Array<{ id: string; revision: number }>) revisions.set(`working:${row.id}`, row.revision)
  for (const row of db.prepare('SELECT id, revision FROM long_term_facts').all() as Array<{ id: string; revision: number }>) revisions.set(`long_term:${row.id}`, row.revision)
  for (const event of events) {
    for (const ref of event.workingRefs.map(item => ({ ...item, layer: 'working' as const }))) {
      const key = `${ref.layer}:${ref.id}`
      const existing = recordMap.get(key)
      if (existing) {
        existing.preparedTurns += 1
        existing.lastPreparedAt = event.preparedAt
        existing.revisionMismatch ||= revisions.get(key) !== ref.revision
      } else {
        recordMap.set(key, { id: ref.id, layer: ref.layer, preparedTurns: 1, lastPreparedAt: event.preparedAt, revisionMismatch: revisions.get(key) !== ref.revision })
      }
    }
    for (const ref of event.longTermRefs.map(item => ({ ...item, layer: 'long_term' as const }))) {
      const key = `${ref.layer}:${ref.id}`
      const existing = recordMap.get(key)
      if (existing) {
        existing.preparedTurns += 1
        existing.lastPreparedAt = event.preparedAt
        existing.revisionMismatch ||= revisions.get(key) !== ref.revision
      } else {
        recordMap.set(key, { id: ref.id, layer: ref.layer, preparedTurns: 1, lastPreparedAt: event.preparedAt, revisionMismatch: revisions.get(key) !== ref.revision })
      }
    }
  }
  return {
    scope: scope.scope,
    ...(scope.scope === 'dialogue' ? { sessionId: scope.sessionId } : {}),
    ...(scope.scope === 'project' ? { projectId: scope.projectId } : {}),
    ...(events[0] === undefined ? {} : { collectionStartedAt: events[0].preparedAt }),
    stored: storageFor(db, scope),
    preparedTurns: events.length,
    ...(events.at(-1) === undefined ? {} : { lastPrepared: events.at(-1) }),
    recordUsage: [...recordMap.values()].sort((a, b) => a.layer.localeCompare(b.layer) || a.id.localeCompare(b.id)),
  }
}
