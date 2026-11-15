import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ChatCostRub, ChatTokenUsage } from '../../shared/chat'

export type StickyFacts = Record<string, string>

export interface FactsUpdate {
  id: string
  sessionId: string
  sourceMessageId: string
  throughMessagePosition: number
  facts: StickyFacts
  usage?: ChatTokenUsage
  costRub?: ChatCostRub
  status: 'completed' | 'failed'
  error?: string
  createdAt: string
}

interface FactsRow {
  id: string
  session_id: string
  source_message_id: string
  through_message_position: number
  facts_json: string
  usage_json: string | null
  cost_json: string | null
  status: FactsUpdate['status']
  error: string | null
  created_at: string
}

function parseJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : JSON.parse(value) as T
}

function toUpdate(row: FactsRow): FactsUpdate {
  const usage = parseJson<ChatTokenUsage>(row.usage_json)
  const costRub = parseJson<ChatCostRub>(row.cost_json)
  return {
    id: row.id,
    sessionId: row.session_id,
    sourceMessageId: row.source_message_id,
    throughMessagePosition: row.through_message_position,
    facts: JSON.parse(row.facts_json) as StickyFacts,
    ...(usage === undefined ? {} : { usage }),
    ...(costRub === undefined ? {} : { costRub }),
    status: row.status,
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
  }
}

export function createFactsRepository(db: Database.Database) {
  function existing(sessionId: string, sourceMessageId: string): FactsUpdate | undefined {
    const row = db.prepare('SELECT * FROM facts_updates WHERE session_id = ? AND source_message_id = ?')
      .get(sessionId, sourceMessageId) as FactsRow | undefined
    return row === undefined ? undefined : toUpdate(row)
  }

  function saveFactsUpdate(input: {
    sessionId: string
    sourceMessageId: string
    throughMessagePosition: number
    facts: StickyFacts
    usage?: ChatTokenUsage
    costRub?: ChatCostRub
    status?: FactsUpdate['status']
    error?: string
  }): FactsUpdate {
    const previous = existing(input.sessionId, input.sourceMessageId)
    if (previous?.status === 'completed') return previous
    const createdAt = new Date().toISOString()
    if (previous) {
      db.prepare(`
        UPDATE facts_updates
        SET through_message_position = ?, facts_json = ?, usage_json = ?, cost_json = ?, status = ?, error = ?, created_at = ?
        WHERE id = ?
      `).run(
        input.throughMessagePosition,
        JSON.stringify(input.facts),
        input.usage === undefined ? null : JSON.stringify(input.usage),
        input.costRub === undefined ? null : JSON.stringify(input.costRub),
        input.status ?? 'completed',
        input.error ?? null,
        createdAt,
        previous.id,
      )
      return toUpdate(db.prepare('SELECT * FROM facts_updates WHERE id = ?').get(previous.id) as FactsRow)
    }
    const id = randomUUID()
    db.prepare(`
      INSERT INTO facts_updates
        (id, session_id, source_message_id, through_message_position, facts_json,
         usage_json, cost_json, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.sourceMessageId,
      input.throughMessagePosition,
      JSON.stringify(input.facts),
      input.usage === undefined ? null : JSON.stringify(input.usage),
      input.costRub === undefined ? null : JSON.stringify(input.costRub),
      input.status ?? 'completed',
      input.error ?? null,
      createdAt,
    )
    return toUpdate(db.prepare('SELECT * FROM facts_updates WHERE id = ?').get(id) as FactsRow)
  }

  function latestFacts(sessionId: string, throughMessagePosition = Number.MAX_SAFE_INTEGER): StickyFacts {
    const row = db.prepare(`
      SELECT * FROM facts_updates
      WHERE session_id = ? AND through_message_position <= ? AND status = 'completed'
      ORDER BY through_message_position DESC, created_at DESC
      LIMIT 1
    `).get(sessionId, throughMessagePosition) as FactsRow | undefined
    return row === undefined ? {} : toUpdate(row).facts
  }

  function latestPosition(sessionId: string): number | undefined {
    const row = db.prepare(`
      SELECT through_message_position
      FROM facts_updates
      WHERE session_id = ? AND status = 'completed'
      ORDER BY through_message_position DESC
      LIMIT 1
    `).get(sessionId) as { through_message_position: number } | undefined
    return row?.through_message_position
  }

  function listFactsUpdates(sessionId: string): FactsUpdate[] {
    const rows = db.prepare('SELECT * FROM facts_updates WHERE session_id = ? ORDER BY through_message_position ASC, created_at ASC')
      .all(sessionId) as FactsRow[]
    return rows.map(toUpdate)
  }

  return { existing, saveFactsUpdate, latestFacts, latestPosition, listFactsUpdates }
}
