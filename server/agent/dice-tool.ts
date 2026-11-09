import { randomInt } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'

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

export function createDiceTool(draw: typeof randomInt = randomInt) {
  return tool({
    description: 'Roll one die and return its actual random result.',
    inputSchema: z.object({
      sides: z.number().int().min(MIN_DIE_SIDES).max(MAX_DIE_SIDES).default(DEFAULT_DIE_SIDES),
    }),
    execute: ({ sides }) => rollDie(sides, draw),
  })
}
