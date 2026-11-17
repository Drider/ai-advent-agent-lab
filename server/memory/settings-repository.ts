import type Database from 'better-sqlite3'
import { validateMemoryBudgetPatch, type MemoryBudgetPatch, type MemoryBudgets } from '../../shared/memory'
import { MemoryError } from './errors'

interface MemorySettingsRow {
  working_tokens: number
  long_term_tokens: number
  revision: number
}

function toBudgets(row: MemorySettingsRow): MemoryBudgets {
  return {
    workingTokens: row.working_tokens,
    longTermTokens: row.long_term_tokens,
    revision: row.revision,
  }
}

export function createMemorySettingsRepository(db: Database.Database) {
  function get(): MemoryBudgets {
    const row = db.prepare('SELECT working_tokens, long_term_tokens, revision FROM memory_settings WHERE id = 1')
      .get() as MemorySettingsRow | undefined
    if (!row) throw new MemoryError('NOT_FOUND', 'memory settings are not initialized')
    return toBudgets(row)
  }

  function update(input: MemoryBudgetPatch): MemoryBudgets {
    try {
      validateMemoryBudgetPatch(input)
    } catch (error) {
      throw new MemoryError('INVALID_INPUT', error instanceof Error ? error.message : 'invalid memory budget')
    }

    const current = get()
    if (current.revision !== input.expectedRevision) {
      throw new MemoryError('REVISION_CONFLICT', 'memory budgets were changed by another request')
    }
    const next = {
      workingTokens: input.workingTokens ?? current.workingTokens,
      longTermTokens: input.longTermTokens ?? current.longTermTokens,
    }
    const result = db.prepare(`
      UPDATE memory_settings
      SET working_tokens = ?, long_term_tokens = ?, revision = revision + 1, updated_at = ?
      WHERE id = 1 AND revision = ?
    `).run(next.workingTokens, next.longTermTokens, new Date().toISOString(), input.expectedRevision)
    if (result.changes !== 1) throw new MemoryError('REVISION_CONFLICT', 'memory budgets were changed by another request')
    return get()
  }

  return { get, update }
}
