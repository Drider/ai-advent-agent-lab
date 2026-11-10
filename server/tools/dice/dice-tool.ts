import { randomInt } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import type { DiceRollRepository } from '../../persistence/dice-roll-repository'
import { appendDiceRoll, readDiceRolls } from './dice-roll-csv'

const DEFAULT_DIE_SIDES = 6
const MIN_DIE_SIDES = 2
const MAX_DIE_SIDES = 1000

export interface DieRoll {
  sides: number
  result: number
}

function validateSides(sides: number): void {
  if (!Number.isInteger(sides) || sides < MIN_DIE_SIDES || sides > MAX_DIE_SIDES) {
    throw new Error('sides must be an integer between 2 and 1000')
  }
}

export function rollDie(sides = DEFAULT_DIE_SIDES, draw: typeof randomInt = randomInt): DieRoll {
  validateSides(sides)

  return {
    sides,
    result: draw(1, sides + 1),
  }
}

export function createDiceTool(
  draw: typeof randomInt = randomInt,
  options: { filePath?: string; now?: () => Date; repository?: DiceRollRepository } = {},
) {
  return tool({
    description: 'Roll one die, save the result to a local CSV file, and return the actual random result.',
    inputSchema: z.object({
      sides: z.number().int().min(MIN_DIE_SIDES).max(MAX_DIE_SIDES).default(DEFAULT_DIE_SIDES),
    }),
    execute: async ({ sides }, executionOptions) => {
      if (options.repository) {
        return options.repository.rollOnce({
          toolCallId: executionOptions.toolCallId,
          sides,
          draw,
          at: options.now?.() ?? new Date(),
        })
      }
      const roll = rollDie(sides, draw)
      await appendDiceRoll(roll.result, options.now?.() ?? new Date(), options.filePath)
      return roll
    },
  })
}

export function createListSavedRollsTool(options: { filePath?: string; repository?: DiceRollRepository } = {}) {
  return tool({
    description: 'List all dice rolls saved in the local CSV file, including their result and UTC date and time.',
    inputSchema: z.object({}),
    execute: async () => options.repository ? options.repository.listRolls() : readDiceRolls(options.filePath),
  })
}
