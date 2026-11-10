import { randomInt } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createDiceRollRepository } from '../server/persistence/dice-roll-repository'

const temporaryDirectories: string[] = []

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-dice-db-'))
  temporaryDirectories.push(directory)
  return join(directory, 'chat.sqlite')
}

function fixedDraw(result: number): typeof randomInt {
  return (() => result) as typeof randomInt
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('dice roll repository', () => {
  it('stores one result for a tool call and returns it again after reopen', async () => {
    const filePath = await createDatabasePath()
    const firstDb = openChatDatabase(filePath)
    const first = createDiceRollRepository(firstDb)
    const at = new Date('2026-11-10T12:00:00.000Z')

    expect(first.rollOnce({ toolCallId: 'call-1', sides: 6, draw: fixedDraw(4), at })).toEqual({ sides: 6, result: 4 })
    expect(first.rollOnce({ toolCallId: 'call-1', sides: 6, draw: fixedDraw(5), at })).toEqual({ sides: 6, result: 4 })
    expect(first.listRolls()).toHaveLength(1)
    firstDb.close()

    const secondDb = openChatDatabase(filePath)
    expect(createDiceRollRepository(secondDb).listRolls()).toEqual([
      { result: 4, date: '2026-11-10', time: '12:00:00.000Z' },
    ])
    secondDb.close()
  })

  it('imports a legacy CSV once and exports the stable header and row order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-dice-csv-import-'))
    temporaryDirectories.push(directory)
    const csvPath = join(directory, 'dice-rolls.csv')
    await writeFile(csvPath, 'result,date,time\n4,2026-11-09,12:00:01.000Z\n6,2026-11-09,12:00:02.000Z\n', 'utf8')
    const db = openChatDatabase(await createDatabasePath())
    const repository = createDiceRollRepository(db)

    expect(await repository.importLegacyCsv(csvPath)).toBe(2)
    expect(await repository.importLegacyCsv(csvPath)).toBe(0)
    expect(repository.exportCsv()).toBe(
      'result,date,time\n4,2026-11-09,12:00:01.000Z\n6,2026-11-09,12:00:02.000Z\n',
    )
    db.close()
  })
})
