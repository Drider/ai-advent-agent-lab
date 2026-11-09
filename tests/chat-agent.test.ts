import { randomInt } from 'node:crypto'
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import {
  simulateReadableStream,
  type UIMessage,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createChatAgent, streamChatAgent } from '../server/agent/chat-agent'
import { createDiceTool } from '../server/agent/dice-tool'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    warnings: [],
  }
}

function toolCallResult(toolCallId: string, sides = 6): LanguageModelV3GenerateResult {
  return {
    content: [{
      type: 'tool-call',
      toolCallId,
      toolName: 'rollDie',
      input: JSON.stringify({ sides }),
    }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  }
}

function streamResult(chunks: LanguageModelV3StreamPart[]): LanguageModelV3StreamResult {
  return {
    stream: simulateReadableStream({ chunks }),
  }
}

function streamTextResult(text: string): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
  ])
}

function streamToolCallResult(toolCallId: string, sides = 6): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'rollDie',
      input: JSON.stringify({ sides }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
  ])
}

function userMessage(text: string): UIMessage {
  return {
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text }],
  }
}

function fixedDraw(result: number): typeof randomInt {
  return (() => result) as typeof randomInt
}

describe('chat agent', () => {
  it('executes a dice tool and feeds its result into the next model step', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallResult('call-1', 20),
        textResult('Выпало 17.'),
      ],
    })

    const result = await createChatAgent(model, createDiceTool(fixedDraw(17))).generate({
      prompt: 'Брось d20',
    })

    expect(result.text).toBe('Выпало 17.')
    expect(result.steps).toHaveLength(2)
    expect(model.doGenerateCalls).toHaveLength(2)
  })

  it('uses each result when the model requests two sequential rolls', async () => {
    const results = [4, 6]
    const draw = (() => results.shift() ?? 1) as typeof randomInt
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallResult('call-1'),
        toolCallResult('call-2'),
        textResult('Результаты: 4 и 6.'),
      ],
    })

    const result = await createChatAgent(model, createDiceTool(draw)).generate({
      prompt: 'Брось два кубика',
    })

    expect(result.text).toBe('Результаты: 4 и 6.')
    expect(result.steps).toHaveLength(3)
    expect(results).toEqual([])
  })

  it('returns ordinary answers without invoking the dice tool', async () => {
    const model = new MockLanguageModelV3({ doGenerate: textResult('Париж.') })

    const result = await createChatAgent(model, createDiceTool(fixedDraw(1))).generate({
      prompt: 'Столица Франции?',
    })

    expect(result.text).toBe('Париж.')
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  it('returns the final answer through an AI SDK UI message stream', async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        streamToolCallResult('call-1', 20),
        streamTextResult('Выпало 17.'),
      ],
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [userMessage('Брось d20')],
    }, createDiceTool(fixedDraw(17)))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Выпало 17.')
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('stops a looping model with an explicit error after ten steps', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => toolCallResult(`call-${++call}`),
    })

    await expect(createChatAgent(model, createDiceTool(fixedDraw(3))).generate({
      prompt: 'Продолжай бросать',
    })).rejects.toThrow('agent stopped after 10 steps')
    expect(model.doGenerateCalls).toHaveLength(10)
  })

  it('surfaces provider failures instead of returning a successful answer', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('tool calling is not supported')
      },
    })

    const response = await streamChatAgent({
      model,
      modelId: 'unsupported-model',
      messages: [userMessage('Брось кубик')],
    })
    const body = await response.text()

    expect(body).toContain('Не удалось получить ответ агента')
    expect(body).not.toContain('Выпало')
  })

  it('does not start a new step after the request is aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1
        controller.abort()
        return toolCallResult('call-1')
      },
    })

    await expect(createChatAgent(model, createDiceTool(fixedDraw(2))).generate({
      prompt: 'Брось кубик',
      abortSignal: controller.signal,
    })).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
