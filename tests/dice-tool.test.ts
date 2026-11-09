import { randomInt } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { rollDie } from '../server/agent/dice-tool'

function fixedDraw(result: number, calls: Array<[number, number]>) {
  return ((min: number, max: number) => {
    calls.push([min, max])
    return result
  }) as typeof randomInt
}

describe('rollDie', () => {
  it('rolls a d6 using an exclusive upper bound', () => {
    const calls: Array<[number, number]> = []

    expect(rollDie(undefined, fixedDraw(4, calls))).toEqual({ sides: 6, result: 4 })
    expect(calls).toEqual([[1, 7]])
  })

  it('uses the requested number of sides', () => {
    const calls: Array<[number, number]> = []

    expect(rollDie(20, fixedDraw(17, calls))).toEqual({ sides: 20, result: 17 })
    expect(calls).toEqual([[1, 21]])
  })

  it('allows both endpoints of the result range', () => {
    expect(rollDie(2, fixedDraw(1, []))).toEqual({ sides: 2, result: 1 })
    expect(rollDie(2, fixedDraw(2, []))).toEqual({ sides: 2, result: 2 })
  })

  it.each([1, 1001, 2.5])('rejects %s sides', (sides) => {
    expect(() => rollDie(sides)).toThrow('sides must be an integer between 2 and 1000')
  })

  it('draws a fresh result for every call', () => {
    const calls: Array<[number, number]> = []
    const draw = fixedDraw(3, calls)

    rollDie(6, draw)
    rollDie(6, draw)

    expect(calls).toHaveLength(2)
  })
})
