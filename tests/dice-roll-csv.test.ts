import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendDiceRoll, readDiceRolls } from '../server/tools/dice'

describe('appendDiceRoll', () => {
  it('keeps a single header and every result when rolls are saved concurrently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-dice-csv-'))
    const filePath = join(directory, 'dice-rolls.csv')

    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => {
        return appendDiceRoll(index + 1, new Date('2026-11-09T12:00:00.000Z'), filePath)
      }))

      const rows = (await readFile(filePath, 'utf8')).trimEnd().split('\n')
      expect(rows[0]).toBe('result,date,time')
      expect(rows.slice(1)).toEqual(Array.from({ length: 20 }, (_, index) => {
        return `${index + 1},2026-11-09,12:00:00.000Z`
      }))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads saved rolls in the order they were written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-dice-csv-'))
    const filePath = join(directory, 'dice-rolls.csv')

    try {
      await appendDiceRoll(4, new Date('2026-11-09T12:00:01.000Z'), filePath)
      await appendDiceRoll(6, new Date('2026-11-09T12:00:02.000Z'), filePath)

      await expect(readDiceRolls(filePath)).resolves.toEqual([
        { result: 4, date: '2026-11-09', time: '12:00:01.000Z' },
        { result: 6, date: '2026-11-09', time: '12:00:02.000Z' },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns an empty list when no rolls have been saved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-dice-csv-'))

    try {
      await expect(readDiceRolls(join(directory, 'dice-rolls.csv'))).resolves.toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
