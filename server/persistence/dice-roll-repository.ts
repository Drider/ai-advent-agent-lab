import { randomInt } from 'node:crypto'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { readDiceRolls, type SavedDiceRoll } from '../tools/dice/dice-roll-csv'
import type { DieRoll } from '../tools/dice/dice-tool'

const MIN_DIE_SIDES = 2
const MAX_DIE_SIDES = 1000
const CSV_HEADER = 'result,date,time'

export interface DiceRollRepository {
  rollOnce(input: {
    toolCallId: string
    sides: number
    draw?: typeof randomInt
    at?: Date
  }): DieRoll
  listRolls(): SavedDiceRoll[]
  importLegacyCsv(path: string): Promise<number>
  exportCsv(): string
}

function validateSides(sides: number): void {
  if (!Number.isInteger(sides) || sides < MIN_DIE_SIDES || sides > MAX_DIE_SIDES) {
    throw new Error('sides must be an integer between 2 and 1000')
  }
}

export function createDiceRollRepository(db: Database.Database): DiceRollRepository {
  const transaction = db.transaction((callback: () => void) => callback())

  function rollOnce(input: {
    toolCallId: string
    sides: number
    draw?: typeof randomInt
    at?: Date
  }): DieRoll {
    validateSides(input.sides)
    const existing = db.prepare('SELECT sides, result FROM dice_rolls WHERE tool_call_id = ?').get(input.toolCallId) as { sides: number; result: number } | undefined
    if (existing) {
      return { sides: existing.sides, result: existing.result }
    }

    const result = (input.draw ?? randomInt)(1, input.sides + 1)
    const rolledAt = (input.at ?? new Date()).toISOString()
    transaction.immediate(() => {
      const raced = db.prepare('SELECT sides, result FROM dice_rolls WHERE tool_call_id = ?').get(input.toolCallId) as { sides: number; result: number } | undefined
      if (!raced) {
        db.prepare(`
          INSERT INTO dice_rolls
            (tool_call_id, sides, result, rolled_at, source, source_row_index)
          VALUES (?, ?, ?, ?, 'runtime', NULL)
        `).run(input.toolCallId, input.sides, result, rolledAt)
      }
    })

    const saved = db.prepare('SELECT sides, result FROM dice_rolls WHERE tool_call_id = ?').get(input.toolCallId) as { sides: number; result: number }
    return { sides: saved.sides, result: saved.result }
  }

  function listRolls(): SavedDiceRoll[] {
    const rows = db.prepare(`
      SELECT result, rolled_at
      FROM dice_rolls
      ORDER BY id ASC
    `).all() as Array<{ result: number; rolled_at: string }>
    return rows.map(row => {
      const timestamp = row.rolled_at
      return {
        result: row.result,
        date: timestamp.slice(0, 10),
        time: timestamp.slice(11),
      }
    })
  }

  async function importLegacyCsv(path: string): Promise<number> {
    const source = resolve(path)
    const rolls = await readDiceRolls(path)
    let imported = 0
    transaction.immediate(() => {
      for (const [sourceRowIndex, roll] of rolls.entries()) {
        const exists = db.prepare('SELECT 1 FROM dice_rolls WHERE source = ? AND source_row_index = ?')
          .get(source, sourceRowIndex)
        if (exists) {
          continue
        }
        const sides = Math.max(6, roll.result)
        db.prepare(`
          INSERT INTO dice_rolls
            (tool_call_id, sides, result, rolled_at, source, source_row_index)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          `legacy:${source}:${sourceRowIndex}`,
          sides,
          roll.result,
          `${roll.date}T${roll.time}`,
          source,
          sourceRowIndex,
        )
        imported += 1
      }
    })
    return imported
  }

  function exportCsv(): string {
    const rows = listRolls()
    return `${CSV_HEADER}\n${rows.map(row => `${row.result},${row.date},${row.time}`).join('\n')}${rows.length > 0 ? '\n' : ''}`
  }

  return { rollOnce, listRolls, importLegacyCsv, exportCsv }
}
