import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  validateForbiddenPatterns,
  validateInvariantCategory,
  validateInvariantId,
  validateInvariantRule,
  validateInvariantTitle,
  type Invariant,
  type InvariantCategory,
  type InvariantChange,
} from '../../shared/invariant'

interface InvariantRow {
  id: string
  category: InvariantCategory
  title: string
  rule: string
  forbidden_json: string
  created_at: string
  updated_at: string
}

interface InvariantChangeRow {
  id: string
  invariant_id: string
  action: InvariantChange['action']
  before_json: string | null
  after_json: string | null
  changed_at: string
}

export class InvariantRepositoryError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'InvariantRepositoryError'
  }
}

function parseStoredInvariant(row: InvariantRow): Invariant {
  const forbidden = JSON.parse(row.forbidden_json) as unknown
  if (!Array.isArray(forbidden) || !forbidden.every(item => typeof item === 'string')) {
    throw new Error(`stored invariant ${row.id} has invalid forbidden patterns`)
  }
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    rule: row.rule,
    forbidden,
    updatedAt: row.updated_at,
  }
}

function parseChange(row: InvariantChangeRow): InvariantChange {
  return {
    id: row.id,
    invariantId: row.invariant_id,
    action: row.action,
    before: row.before_json ? JSON.parse(row.before_json) as Invariant : null,
    after: row.after_json ? JSON.parse(row.after_json) as Invariant : null,
    changedAt: row.changed_at,
  }
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/u)
    .map(part => part ? part[0]!.toUpperCase() + part.slice(1) : part)
    .join(' ')
}

function toError(error: unknown): InvariantRepositoryError {
  return error instanceof InvariantRepositoryError
    ? error
    : new InvariantRepositoryError('INVALID_INPUT', error instanceof Error ? error.message : 'invalid invariant')
}

export function createInvariantRepository(db: Database.Database) {
  const fields = 'id, category, title, rule, forbidden_json, created_at, updated_at'

  function get(id: string): Invariant | undefined {
    const row = db.prepare(`SELECT ${fields} FROM invariants WHERE id = ?`).get(id) as InvariantRow | undefined
    return row ? parseStoredInvariant(row) : undefined
  }

  function list(): Invariant[] {
    const rows = db.prepare(`SELECT ${fields} FROM invariants ORDER BY category, id`).all() as InvariantRow[]
    return rows.map(parseStoredInvariant)
  }

  function listChanges(limit = 50): InvariantChange[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 200)) : 50
    const rows = db.prepare(`
      SELECT id, invariant_id, action, before_json, after_json, changed_at
      FROM invariant_changes
      ORDER BY changed_at DESC, rowid DESC
      LIMIT ?
    `).all(safeLimit) as InvariantChangeRow[]
    return rows.map(parseChange)
  }

  function recordChange(
    invariantId: string,
    action: InvariantChange['action'],
    before: Invariant | null,
    after: Invariant | null,
    changedAt: string,
  ): void {
    db.prepare(`
      INSERT INTO invariant_changes (id, invariant_id, action, before_json, after_json, changed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      invariantId,
      action,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      changedAt,
    )
  }

  function upsert(input: {
    id: string
    category?: InvariantCategory
    title?: string
    rule: string
    forbidden?: string[]
  }): Invariant {
    let id: string
    let rule: string
    let category: InvariantCategory | undefined
    let title: string | undefined
    let forbidden: string[] | undefined
    try {
      id = validateInvariantId(input.id)
      rule = validateInvariantRule(input.rule)
      category = input.category === undefined ? undefined : validateInvariantCategory(input.category)
      title = input.title === undefined ? undefined : validateInvariantTitle(input.title)
      forbidden = input.forbidden === undefined ? undefined : validateForbiddenPatterns(input.forbidden)
    } catch (error) {
      throw toError(error)
    }

    const transaction = db.transaction(() => {
      const before = get(id)
      const now = new Date().toISOString()
      const next: Invariant = {
        id,
        category: category ?? before?.category ?? 'decision',
        title: title ?? before?.title ?? titleFromId(id),
        rule,
        forbidden: forbidden ?? before?.forbidden ?? [],
        updatedAt: now,
      }
      if (before === undefined) {
        db.prepare(`
          INSERT INTO invariants (id, category, title, rule, forbidden_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(next.id, next.category, next.title, next.rule, JSON.stringify(next.forbidden), now, now)
      } else {
        db.prepare(`
          UPDATE invariants
          SET category = ?, title = ?, rule = ?, forbidden_json = ?, updated_at = ?
          WHERE id = ?
        `).run(next.category, next.title, next.rule, JSON.stringify(next.forbidden), now, next.id)
      }
      const after = get(id)!
      recordChange(id, before === undefined ? 'create' : 'update', before ?? null, after, now)
      return after
    })
    return transaction.immediate()
  }

  function setForbidden(idInput: string, patternsInput: unknown): Invariant {
    let id: string
    let forbidden: string[]
    try {
      id = validateInvariantId(idInput)
      forbidden = validateForbiddenPatterns(patternsInput)
    } catch (error) {
      throw toError(error)
    }

    const transaction = db.transaction(() => {
      const before = get(id)
      if (!before) throw new InvariantRepositoryError('NOT_FOUND', 'invariant was not found')
      const now = new Date().toISOString()
      db.prepare('UPDATE invariants SET forbidden_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(forbidden), now, id)
      const after = get(id)!
      recordChange(id, 'update', before, after, now)
      return after
    })
    return transaction.immediate()
  }

  function remove(idInput: string): boolean {
    let id: string
    try {
      id = validateInvariantId(idInput)
    } catch (error) {
      throw toError(error)
    }

    const transaction = db.transaction(() => {
      const before = get(id)
      if (!before) return false
      const changedAt = new Date().toISOString()
      db.prepare('DELETE FROM invariants WHERE id = ?').run(id)
      recordChange(id, 'remove', before, null, changedAt)
      return true
    })
    return transaction.immediate()
  }

  return { get, list, listChanges, upsert, setForbidden, remove }
}
