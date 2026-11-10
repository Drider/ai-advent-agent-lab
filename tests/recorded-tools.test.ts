import { tool, type Tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { recordToolExecution } from '../server/agent/recorded-tools'
import { z } from 'zod'

type Repository = Parameters<typeof recordToolExecution>[1]['repository']

function createTool(execute: (input: { value: string }, options: { toolCallId: string }) => Promise<string>): Tool {
  return tool({
    inputSchema: z.object({ value: z.string() }),
    execute,
  })
}

function executionOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} }
}

describe('recordToolExecution', () => {
  it('commits intent before execution and output after execution', async () => {
    const events: string[] = []
    const repository: Repository = {
      recordToolStart: async () => { events.push('intent-committed') },
      recordToolEnd: async () => { events.push('result-committed') },
    }
    const wrapped = recordToolExecution(createTool(async (input) => {
      events.push('tool-executed')
      return input.value.toUpperCase()
    }), { turnId: 'turn-1', getStepIndex: () => 2, repository, toolName: 'mutating' })

    await expect(wrapped.execute?.({ value: 'ok' }, executionOptions('call-1'))).resolves.toBe('OK')
    expect(events).toEqual(['intent-committed', 'tool-executed', 'result-committed'])
  })

  it('does not execute a side effect when intent persistence fails', async () => {
    const executeSpy = vi.fn(async () => 'never')
    const wrapped = recordToolExecution(createTool(executeSpy), {
      turnId: 'turn-1',
      getStepIndex: () => 0,
      repository: {
        recordToolStart: async () => { throw new Error('intent failed') },
        recordToolEnd: async () => undefined,
      },
    })

    await expect(wrapped.execute?.({ value: 'x' }, executionOptions('call-1'))).rejects.toThrow('intent failed')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('surfaces a result persistence failure without retrying the tool', async () => {
    const executeSpy = vi.fn(async () => 'side effect happened')
    const wrapped = recordToolExecution(createTool(executeSpy), {
      turnId: 'turn-1',
      getStepIndex: () => 0,
      repository: {
        recordToolStart: async () => undefined,
        recordToolEnd: async () => { throw new Error('result failed') },
      },
    })

    await expect(wrapped.execute?.({ value: 'x' }, executionOptions('call-1'))).rejects.toThrow('result failed')
    expect(executeSpy).toHaveBeenCalledOnce()
  })

  it('uses the same current step index for parallel tool calls', async () => {
    const stepIndexes: number[] = []
    const wrapped = recordToolExecution(createTool(async () => 'ok'), {
      turnId: 'turn-1',
      getStepIndex: () => 7,
      repository: {
        recordToolStart: async ({ stepIndex }) => { stepIndexes.push(stepIndex) },
        recordToolEnd: async () => undefined,
      },
    })

    await Promise.all([
      wrapped.execute?.({ value: 'a' }, executionOptions('call-1')),
      wrapped.execute?.({ value: 'b' }, executionOptions('call-2')),
    ])
    expect(stepIndexes).toEqual([7, 7])
  })
})
