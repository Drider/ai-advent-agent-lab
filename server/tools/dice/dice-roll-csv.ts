import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const defaultFilePath = join(process.cwd(), 'data', 'dice-rolls.csv')
const DICE_ROLL_HEADER = 'result,date,time'
const pendingWrites = new Map<string, Promise<void>>()

export interface SavedDiceRoll {
  result: number
  date: string
  time: string
}

async function needsHeader(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).size === 0
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return true
    }

    throw error
  }
}

export async function appendDiceRoll(
  result: number,
  at = new Date(),
  filePath = defaultFilePath,
): Promise<void> {
  const timestamp = at.toISOString()
  const row = `${result},${timestamp.slice(0, 10)},${timestamp.slice(11)}\n`
  const previousWrite = pendingWrites.get(filePath) ?? Promise.resolve()
  const nextWrite = previousWrite.catch(() => undefined).then(async () => {
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, `${await needsHeader(filePath) ? `${DICE_ROLL_HEADER}\n` : ''}${row}`, 'utf8')
  })

  pendingWrites.set(filePath, nextWrite)

  try {
    await nextWrite
  } finally {
    if (pendingWrites.get(filePath) === nextWrite) {
      pendingWrites.delete(filePath)
    }
  }
}

/** Reads saved dice rolls from the local CSV file in write order. */
export async function readDiceRolls(filePath = defaultFilePath): Promise<SavedDiceRoll[]> {
  let contents: string
  try {
    contents = await readFile(filePath, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }

  const normalizedContents = contents.trimEnd()
  if (!normalizedContents) {
    return []
  }

  const rows = normalizedContents.split(/\r?\n/)
  if (rows[0] !== DICE_ROLL_HEADER) {
    throw new Error('dice roll CSV has an invalid header')
  }

  return rows.slice(1).filter(Boolean).map((row, index) => {
    const columns = row.split(',')
    const result = Number(columns[0])
    const date = columns[1]
    const time = columns[2]

    if (columns.length !== 3 || !Number.isSafeInteger(result) || !date || !time) {
      throw new Error(`dice roll CSV has an invalid row at line ${index + 2}`)
    }

    return { result, date, time }
  })
}
