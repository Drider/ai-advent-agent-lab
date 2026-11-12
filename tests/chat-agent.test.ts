import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import {
  simulateReadableStream,
  tool,
  type UIMessage,
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatAgent, MAX_AGENT_STEPS, streamChatAgent } from '../server/agent/chat-agent'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import type { ChatUIMessage } from '../shared/chat'
import { createDiceTool, createListSavedRollsTool } from '../server/tools/dice'
import { createFileTools, type FileTools } from '../server/tools/files'
import { createSessionTools } from '../server/tools/sessions'

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

function savedRollsToolCallResult(toolCallId: string): LanguageModelV3GenerateResult {
  return {
    content: [{
      type: 'tool-call',
      toolCallId,
      toolName: 'listSavedRolls',
      input: '{}',
    }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  }
}

function fileToolCallResult(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3GenerateResult {
  return {
    content: [{
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage,
    warnings: [],
  }
}

function multiFileToolCallResult(
  calls: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }>,
): LanguageModelV3GenerateResult {
  return {
    content: calls.map(call => ({
      type: 'tool-call' as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    })),
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

function streamTextResult(
  text: string,
  tokenUsage: LanguageModelV3GenerateResult['usage'] = usage,
): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: text },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: tokenUsage },
  ])
}

function streamToolCallResult(
  toolCallId: string,
  sides = 6,
  tokenUsage: LanguageModelV3GenerateResult['usage'] = usage,
): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName: 'rollDie',
      input: JSON.stringify({ sides }),
    },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: tokenUsage },
  ])
}

function streamFileToolCallResult(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3StreamResult {
  return streamResult([
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(input),
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

const loggedRunId = '2026-11-09T12:05:00.000Z'
const loggedFileRunId = '2026-11-09T12:06:00.000Z'
let rollDirectory: string
let fileDirectory: string

beforeEach(async () => {
  rollDirectory = await mkdtemp(join(tmpdir(), 'agent-chat-dice-rolls-'))
  fileDirectory = await mkdtemp(join(tmpdir(), 'agent-chat-file-tools-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all([
    rm(join(process.cwd(), 'data', 'runs', `run-${loggedRunId}.json`), { force: true }),
    rm(rollDirectory, { recursive: true, force: true }),
    rm(join(process.cwd(), 'data', 'runs', 'run-' + loggedFileRunId + '.json'), { force: true }),
    rm(fileDirectory, { recursive: true, force: true }),
  ])
})

function createTestDiceTool(draw: typeof randomInt, now = () => new Date()) {
  return createDiceTool(draw, { filePath: join(rollDirectory, 'dice-rolls.csv'), now })
}

function createTestSavedRollsTool() {
  return createListSavedRollsTool({ filePath: join(rollDirectory, 'dice-rolls.csv') })
}

function createTestFileTools() {
  return createFileTools({ rootDir: fileDirectory })
}

describe('chat agent', () => {
  it('executes a dice tool and feeds its result into the next model step', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallResult('call-1', 20),
        textResult('Выпало 17.'),
      ],
    })

    const result = await createChatAgent(model, createTestDiceTool(fixedDraw(17))).generate({
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

    const moments = [
      new Date('2026-11-09T12:00:01.000Z'),
      new Date('2026-11-09T12:00:02.000Z'),
    ]
    const result = await createChatAgent(model, createTestDiceTool(draw, () => moments.shift()!)).generate({
      prompt: 'Брось два кубика',
    })

    expect(result.text).toBe('Результаты: 4 и 6.')
    expect(result.steps).toHaveLength(3)
    expect(results).toEqual([])
    expect(await readFile(join(rollDirectory, 'dice-rolls.csv'), 'utf8')).toBe(
      'result,date,time\n4,2026-11-09,12:00:01.000Z\n6,2026-11-09,12:00:02.000Z\n',
    )
  })

  it('executes the saved-rolls tool when the model requests roll history', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        toolCallResult('call-1'),
        savedRollsToolCallResult('call-2'),
        textResult('Сохранённый бросок: 4.'),
      ],
    })

    const result = await createChatAgent(
      model,
      createTestDiceTool(fixedDraw(4)),
      {},
      createTestSavedRollsTool(),
    ).generate({
      prompt: 'Брось кубик и покажи сохранённые броски',
    })

    expect(result.text).toBe('Сохранённый бросок: 4.')
    expect(result.steps).toHaveLength(3)
    expect(result.steps[1]?.toolResults).toMatchObject([{
      toolName: 'listSavedRolls',
      output: [{ result: 4, date: expect.any(String), time: expect.any(String) }],
    }])
  })

  it('returns ordinary answers without invoking the dice tool', async () => {
    const model = new MockLanguageModelV3({ doGenerate: textResult('Париж.') })

    const result = await createChatAgent(model, createTestDiceTool(fixedDraw(1))).generate({
      prompt: 'Столица Франции?',
    })

    expect(result.text).toBe('Париж.')
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  it('chains discovery, reads, text processing, and report creation', async () => {
    await mkdir(join(fileDirectory, 'notes'), { recursive: true })
    await Promise.all([
      writeFile(join(fileDirectory, 'notes', 'a.md'), 'TODO: a\nготово'),
      writeFile(join(fileDirectory, 'notes', 'b.md'), 'TODO: b'),
    ])
    const model = new MockLanguageModelV3({
      doGenerate: [
        fileToolCallResult('find-1', 'find_files', { pattern: 'notes/*.md' }),
        multiFileToolCallResult([
          { toolCallId: 'read-a', toolName: 'read_file', input: { path: 'notes/a.md' } },
          { toolCallId: 'read-b', toolName: 'read_file', input: { path: 'notes/b.md' } },
        ]),
        multiFileToolCallResult([
          { toolCallId: 'search-a', toolName: 'search_text', input: { text: 'TODO: a\nготово', query: 'TODO' } },
          { toolCallId: 'stats-a', toolName: 'text_stats', input: { text: 'TODO: a\nготово' } },
          { toolCallId: 'search-b', toolName: 'search_text', input: { text: 'TODO: b', query: 'TODO' } },
          { toolCallId: 'stats-b', toolName: 'text_stats', input: { text: 'TODO: b' } },
        ]),
        fileToolCallResult('write-1', 'write_file', { path: 'reports/todo.md', content: 'TODO: a\nTODO: b' }),
        textResult('Отчёт сохранён в reports/todo.md.'),
      ],
    })

    const result = await createChatAgent(
      model,
      createTestDiceTool(fixedDraw(1)),
      {},
      createTestSavedRollsTool(),
      createTestFileTools(),
    ).generate({ prompt: 'Собери TODO из заметок и сохрани отчёт' })

    expect(result.text).toBe('Отчёт сохранён в reports/todo.md.')
    expect(result.steps).toHaveLength(5)
    expect(result.steps[0]?.toolResults).toMatchObject([{
      toolName: 'find_files',
      output: { ok: true, data: { paths: ['notes/a.md', 'notes/b.md'] } },
    }])
    expect(result.steps[1]?.toolResults).toHaveLength(2)
    expect(result.steps[2]?.toolResults).toHaveLength(4)
    expect(result.steps[3]?.toolResults).toMatchObject([{
      toolName: 'write_file',
      output: { ok: true, data: { path: 'reports/todo.md', bytesWritten: 15 } },
    }])
    expect(await readFile(join(fileDirectory, 'reports', 'todo.md'), 'utf8')).toBe('TODO: a\nTODO: b')
  })

  it('lets the agent discover, read, and analyze a session log', async () => {
    await mkdir(join(fileDirectory, 'runs'), { recursive: true })
    const path = 'runs/run-2026-11-09T12:00:00.000Z.json'
    await writeFile(join(fileDirectory, path), JSON.stringify({
      runId: '2026-11-09T12:00:00.000Z',
      startedAt: '2026-11-09T12:00:00.000Z',
      updatedAt: '2026-11-09T12:00:01.000Z',
      level: 'basic',
      requests: [{
        question: 'Привет', answer: 'Здравствуйте',
        startedAt: '2026-11-09T12:00:00.000Z',
        completedAt: '2026-11-09T12:00:01.000Z',
        durationMs: 1000,
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      }],
    }))
    const model = new MockLanguageModelV3({
      doGenerate: [
        fileToolCallResult('find-session', 'find_files', { pattern: 'runs/*.json' }),
        fileToolCallResult('read-session', 'read_session_file', { path, offset: 0, limit: 10 }),
        fileToolCallResult('analyze-session', 'analyze_sessions', { paths: [path], groupBy: 'day' }),
        textResult('9 ноября: 1 запрос, 7 токенов.'),
      ],
    })
    const result = await createChatAgent(
      model,
      createTestDiceTool(fixedDraw(1)),
      {},
      createTestSavedRollsTool(),
      createTestFileTools(),
      createSessionTools({ rootDir: fileDirectory }),
    ).generate({ prompt: 'Найди и проанализируй лог за 9 ноября' })

    expect(result.text).toBe('9 ноября: 1 запрос, 7 токенов.')
    expect(result.steps[0]?.toolResults).toMatchObject([{ output: { ok: true, data: { paths: [path] } } }])
    expect(result.steps[1]?.toolResults).toMatchObject([{ output: { ok: true, data: { entries: [{ question: 'Привет' }] } } }])
    expect(result.steps[2]?.toolResults).toMatchObject([{ output: { totals: { requests: 1, totalTokens: 7 } } }])
  })

  it('executes independent file reads concurrently in one model step', async () => {
    let started = 0
    let release: (() => void) | undefined
    let resolveBothStarted: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const controlledRead = tool({
      description: 'Controlled test read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        started += 1
        if (started === 2) {
          resolveBothStarted?.()
        }
        await gate
        return { ok: true, data: { path, text: path } }
      },
    })
    const fileTools = {
      ...createTestFileTools(),
      read_file: controlledRead,
    } as FileTools
    const model = new MockLanguageModelV3({
      doGenerate: [
        multiFileToolCallResult([
          { toolCallId: 'read-a', toolName: 'read_file', input: { path: 'a.md' } },
          { toolCallId: 'read-b', toolName: 'read_file', input: { path: 'b.md' } },
        ]),
        textResult('Прочитано два файла.'),
      ],
    })

    const pending = createChatAgent(
      model,
      createTestDiceTool(fixedDraw(1)),
      {},
      createTestSavedRollsTool(),
      fileTools,
    ).generate({ prompt: 'Прочитай два файла' })
    await bothStarted
    expect(started).toBe(2)
    release?.()
    const result = await pending

    expect(result.text).toBe('Прочитано два файла.')
    expect(result.steps[0]?.toolResults).toHaveLength(2)
  })

  it('passes a file tool error back to the model', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        fileToolCallResult('read-missing', 'read_file', { path: 'missing.md' }),
        textResult('Файл не найден, отчёт не создавался.'),
      ],
    })

    const result = await createChatAgent(
      model,
      createTestDiceTool(fixedDraw(1)),
      {},
      createTestSavedRollsTool(),
      createTestFileTools(),
    ).generate({ prompt: 'Прочитай missing.md' })

    expect(result.text).toBe('Файл не найден, отчёт не создавался.')
    expect(result.steps[0]?.toolResults).toMatchObject([{
      toolName: 'read_file',
      output: { ok: false, error: { code: 'NOT_FOUND' } },
    }])
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
      runId: '2026-11-09T12:00:00.000Z',
      logLevel: 'off',
    }, createTestDiceTool(fixedDraw(17)))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('Выпало 17.')
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('binds get_current_session to the current streaming request', async () => {
    const runId = '2099-12-31T23:59:59.999Z'
    const model = new MockLanguageModelV3({
      doStream: [
        streamFileToolCallResult('current-1', 'get_current_session', {}),
        streamTextResult('Текущая сессия пока не сохранена.'),
      ],
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [userMessage('Покажи текущую сессию')],
      runId,
      logLevel: 'off',
    })
    const body = await response.text()

    expect(body).toContain('get_current_session')
    expect(body).toContain(runId)
    expect(body).toContain('currentRequestPersisted')
    expect(body).toContain('Текущая сессия пока не сохранена.')
  })

  it('continues a saved dialogue with instructions outside UI messages', async () => {
    const model = new MockLanguageModelV3({ doStream: streamTextResult('Продолжаю.') })
    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [
        userMessage('Начни'),
        { id: 'previous-answer', role: 'assistant', parts: [{ type: 'text', text: 'Начал.' }] },
        { id: 'follow-up', role: 'user', parts: [{ type: 'text', text: 'Дальше' }] },
        { id: 'failed-answer', role: 'assistant', parts: [] },
      ],
      runId: '2026-11-12T13:58:00.000Z',
      logLevel: 'off',
      disableMutatingTools: true,
    })

    expect(await response.text()).toContain('Продолжаю.')
    expect(model.doStreamCalls).toHaveLength(1)
  })

  it('sends token usage for all agent steps and request duration in message metadata', async () => {
    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)

    try {
      let step = 0
      const model = new MockLanguageModelV3({
        doStream: async () => {
          if (step++ === 0) {
            clock.mockReturnValue(startedAt + 1_000)
            return streamToolCallResult('call-1', 20)
          }

          clock.mockReturnValue(startedAt + 3_500)
          return streamTextResult('Выпало 17.')
        },
      })

      const response = await streamChatAgent({
        model,
        modelId: 'mock-model',
        messages: [userMessage('Брось d20')],
        runId: '2026-11-09T12:00:00.000Z',
        logLevel: 'off',
        pricing: { inputPerMillionRub: 10, outputPerMillionRub: 40 },
      }, createTestDiceTool(fixedDraw(17)))
      const chunks = (await response.text()).split('\n')
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(6)))

      const metadata = chunks.find(chunk => chunk.type === 'finish')?.messageMetadata
      expect(metadata).toMatchObject({
        durationMs: 3_500,
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      })
      expect(metadata.costRub.input).toBeCloseTo(0.0002)
      expect(metadata.costRub.output).toBeCloseTo(0.0004)
      expect(metadata.costRub.total).toBeCloseTo(0.0006)
    } finally {
      clock.mockRestore()
    }
  })

  it('sends cache and reasoning usage separately for each model call and the full reply', async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        streamToolCallResult('detailed-roll', 6, {
          inputTokens: { total: 100, noCache: 25, cacheRead: 75, cacheWrite: 0 },
          outputTokens: { total: 12, text: 10, reasoning: 2 },
        }),
        streamTextResult('Выпало 4.', {
          inputTokens: { total: 150, noCache: 30, cacheRead: 100, cacheWrite: 20 },
          outputTokens: { total: 30, text: 20, reasoning: 10 },
        }),
      ],
    })
    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [userMessage('Брось кубик')],
      runId: '2026-11-12T12:00:00.000Z',
      logLevel: 'off',
    }, createTestDiceTool(fixedDraw(4)))
    const chunks = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
    const metadata = chunks.find(chunk => chunk.type === 'finish')?.messageMetadata

    expect(metadata.usage).toEqual({
      inputTokens: 250,
      outputTokens: 42,
      totalTokens: 292,
      inputTokenDetails: { noCacheTokens: 55, cacheReadTokens: 175, cacheWriteTokens: 20 },
      outputTokenDetails: { textTokens: 30, reasoningTokens: 12 },
    })
    expect(metadata.steps).toEqual([
      { usage: {
        inputTokens: 100, outputTokens: 12, totalTokens: 112,
        inputTokenDetails: { noCacheTokens: 25, cacheReadTokens: 75, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 10, reasoningTokens: 2 },
      } },
      { usage: {
        inputTokens: 150, outputTokens: 30, totalTokens: 180,
        inputTokenDetails: { noCacheTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 20 },
        outputTokenDetails: { textTokens: 20, reasoningTokens: 10 },
      } },
    ])
  })

  it.each([
    {
      name: 'unreported details',
      details: {},
      expectedInput: {},
      expectedOutput: {},
    },
    {
      name: 'explicit zero counts',
      details: {
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      expectedInput: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      expectedOutput: { textTokens: 20, reasoningTokens: 0 },
    },
    {
      name: 'reported cache and reasoning',
      details: {
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      expectedInput: { noCacheTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10 },
      expectedOutput: { textTokens: 15, reasoningTokens: 5 },
    },
  ])('preserves $name through the production OpenAI adapter', async ({ details, expectedInput, expectedOutput }) => {
    const provider = createOpenAI({
      apiKey: 'offline-test',
      fetch: async () => new Response(`data: ${JSON.stringify({
        id: 'offline-usage', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Ответ' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...details },
      })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    })
    const response = await streamChatAgent({
      model: provider.chat('test-model'),
      modelId: 'test-model',
      messages: [userMessage('Привет')],
      runId: '2026-11-12T12:00:00.000Z',
      logLevel: 'off',
    })
    const chunks = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
    const metadata = chunks.find(chunk => chunk.type === 'finish')?.messageMetadata
    const expected = {
      inputTokens: 100, outputTokens: 20, totalTokens: 120,
      inputTokenDetails: expectedInput,
      outputTokenDetails: expectedOutput,
    }
    expect(metadata.usage).toEqual(expected)
    expect(metadata.steps).toEqual([{ usage: expected }])
  })

  it('keeps unavailable token counts unknown while sending the request duration', async () => {
    const model = new MockLanguageModelV3({
      doStream: streamTextResult('Привет.', {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      }),
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [userMessage('Привет')],
      runId: '2026-11-09T12:00:00.000Z',
      logLevel: 'off',
      pricing: { inputPerMillionRub: 10, outputPerMillionRub: 40 },
    })
    const chunks = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
    const metadata = chunks.find(chunk => chunk.type === 'finish')?.messageMetadata

    expect(metadata).toEqual({
      durationMs: expect.any(Number),
      usage: { inputTokenDetails: {}, outputTokenDetails: {} },
      steps: [{ usage: { inputTokenDetails: {}, outputTokenDetails: {} } }],
    })
    expect(metadata.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('streams file tool results and records their names in a detailed log', async () => {
    await writeFile(join(fileDirectory, 'notes.md'), 'TODO: stream')
    const model = new MockLanguageModelV3({
      doStream: [
        streamFileToolCallResult('read-1', 'read_file', { path: 'notes.md' }),
        streamTextResult('Файл прочитан.'),
      ],
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [userMessage('Прочитай notes.md')],
      runId: loggedFileRunId,
      logLevel: 'detailed',
    }, createTestDiceTool(fixedDraw(1)), createTestSavedRollsTool(), createTestFileTools())
    const body = await response.text()
    const log = JSON.parse(await readFile(
      join(process.cwd(), 'data', 'runs', 'run-' + loggedFileRunId + '.json'),
      'utf8',
    )) as { requests: Array<Record<string, unknown>> }

    expect(body).toContain('Файл прочитан.')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(log.requests[0])).toContain('read_file')
  })

  it('reserves the last step for a response without starting another tool call', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => ++call < MAX_AGENT_STEPS ? toolCallResult(`call-${call}`) : textResult('Работа выполнена частично.'),
    })

    const result = await createChatAgent(model, createTestDiceTool(fixedDraw(3))).generate({
      prompt: 'Продолжай бросать',
    })

    expect(result.text).toBe('Работа выполнена частично.')
    expect(model.doGenerateCalls).toHaveLength(MAX_AGENT_STEPS)
    expect(model.doGenerateCalls[MAX_AGENT_STEPS - 1]?.toolChoice).toEqual({ type: 'none' })
    expect(model.doGenerateCalls[MAX_AGENT_STEPS - 1]?.prompt).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('Finish the current response') }),
    ]))
  })

  it('saves a step-limited response as resumable instead of completed', async () => {
    const db = openChatDatabase(join(fileDirectory, 'chat.sqlite'))
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const message = userMessage('Сделай много действий') as ChatUIMessage
    const turnId = randomUUID()
    turns.beginUserTurn({ sessionId: session.id, requestId: turnId, modelId: 'mock-model', message, agentConfig: { version: 1 } })
    const model = new MockLanguageModelV3({
      doStream: [
        ...Array.from({ length: MAX_AGENT_STEPS - 1 }, (_, index) => streamToolCallResult(`call-${index + 1}`)),
        streamTextResult('Промежуточный результат.'),
      ],
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [message],
      runId: session.runLogId,
      logLevel: 'off',
      sessionId: session.id,
      turnId,
      turnRepository: turns,
    }, createTestDiceTool(fixedDraw(3)))
    const body = await response.text()

    expect(body).toContain('Промежуточный результат.')
    expect(body).toContain('"stopReason":"step_limit"')
    expect((await sessions.getSession(session.id))?.lastTurn).toMatchObject({
      status: 'interrupted',
      stopReason: 'step_limit',
      continuation: 'safe',
    })
    db.close()
  })

  it('persists a continued response after an interrupted assistant message', async () => {
    const db = openChatDatabase(join(fileDirectory, 'continuation.sqlite'))
    const sessions = createSessionRepository(db)
    const turns = createTurnRepository(db)
    const session = sessions.createSession()
    const sourceTurnId = randomUUID()
    turns.beginUserTurn({
      sessionId: session.id, requestId: sourceTurnId, modelId: 'mock-model',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Подготовь конспект' }] },
      agentConfig: {},
    })
    turns.finishTurn({
      turnId: sourceTurnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Часть конспекта' }] },
      status: 'interrupted', stopReason: 'step_limit',
    })
    const turnId = randomUUID()
    turns.beginContinuation({
      sessionId: session.id, requestId: turnId, sourceTurnId, modelId: 'mock-model',
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Продолжи выполнение предыдущего запроса.' }] },
      agentConfig: {},
    })
    const messages = (await sessions.getSession(session.id))!.messages
    const response = await streamChatAgent({
      model: new MockLanguageModelV3({ doStream: [streamToolCallResult('continued-roll'), streamTextResult('Следующая часть')] }),
      modelId: 'mock-model', messages, runId: session.runLogId, logLevel: 'off',
      sessionId: session.id, turnId, turnRepository: turns,
    }, createTestDiceTool(fixedDraw(3)))
    await response.text()

    const saved = await sessions.getSession(session.id)
    expect(saved?.lastTurn?.status).toBe('completed')
    expect(saved?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(new Set(saved?.messages.map(message => message.id)).size).toBe(4)
    db.close()
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
      runId: '2026-11-09T12:01:00.000Z',
      logLevel: 'off',
    })
    const body = await response.text()

    expect(body).toContain('Не удалось получить ответ агента')
    expect(body).not.toContain('Выпало')
  })

  it('writes one detailed log entry after a streamed response', async () => {
    const model = new MockLanguageModelV3({
      doStream: [
        streamToolCallResult('call-1'),
        streamTextResult('Готово.'),
      ],
    })

    const response = await streamChatAgent({
      model,
      modelId: 'mock-model',
      messages: [userMessage('Проверь логирование')],
      runId: loggedRunId,
      logLevel: 'detailed',
    }, createTestDiceTool(fixedDraw(4)))
    await response.text()

    const log = JSON.parse(await readFile(
      join(process.cwd(), 'data', 'runs', `run-${loggedRunId}.json`),
      'utf8',
    )) as { requests: Array<Record<string, unknown>> }

    expect(log.requests).toHaveLength(1)
    expect(log.requests[0]).toMatchObject({
      question: 'Проверь логирование',
      answer: 'Готово.',
      request: { model: 'mock-model' },
      usage: { totalTokens: 30 },
    })
    expect(log.requests[0]?.steps).toHaveLength(2)
  })

  async function readDiagnosticEntry() {
    const log = JSON.parse(await readFile(join(process.cwd(), 'data', 'runs', `run-${loggedRunId}.json`), 'utf8'))
    expect(log.requests).toHaveLength(1)
    return log.requests[0]
  }

  it.each(['basic', 'detailed', 'raw'] as const)('logs the provider error at the %s level and explains context overflow safely', async (logLevel) => {
    const provider = createOpenAI({
      apiKey: 'server-only-secret',
      baseURL: 'https://provider.example/v1',
      fetch: async () => new Response(JSON.stringify({
        error: { message: 'Maximum context length exceeded (credential: server-only-secret)', type: 'invalid_request_error', code: 'context_length_exceeded' },
      }), { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'req-context-1' } }),
    })
    const response = await streamChatAgent({
      model: provider.chat('small-model'), modelId: 'small-model',
      messages: [userMessage('Продолжай')], runId: loggedRunId, logLevel,
      sessionId: 'session-123', turnId: 'turn-123',
      sensitiveValues: ['server-only-secret'],
    })
    const body = await response.text()

    expect(body).toContain('Контекст модели переполнен')
    expect(body).not.toContain('Maximum context length exceeded')
    const entry = await readDiagnosticEntry()
    expect(entry).toMatchObject({
      status: 'failed', error: 'Maximum context length exceeded (credential: [REDACTED])',
      sessionId: 'session-123', turnId: 'turn-123',
    })
    if (logLevel !== 'basic') {
      expect(entry).toMatchObject({
        errorDetails: {
          name: 'AI_APICallError', statusCode: 400, isRetryable: false,
          url: 'https://provider.example/v1/chat/completions',
          responseHeaders: { 'x-request-id': 'req-context-1' },
          responseBody: expect.stringContaining('context_length_exceeded'),
        },
        diagnostics: { outcome: 'failed' },
      })
    } else {
      expect(entry.errorDetails).toBeUndefined()
    }
    expect(JSON.stringify(entry)).not.toContain('server-only-secret')
  })

  it('marks a polza.ai spending-limit stream as failed and preserves its error code', async () => {
    const db = openChatDatabase(join(fileDirectory, 'chat.sqlite'))
    try {
      const sessions = createSessionRepository(db)
      const turns = createTurnRepository(db)
      const session = sessions.createSession()
      const turnId = randomUUID()
      const message = userMessage('Продолжай')
      turns.beginUserTurn({ sessionId: session.id, requestId: turnId, modelId: 'deepseek/deepseek-v4.1-flash', message: message as ChatUIMessage, agentConfig: {} })
      const provider = createOpenAI({
        apiKey: 'test-key',
        baseURL: 'https://provider.example/v1',
        fetch: async () => new Response(`data: ${JSON.stringify({
          id: 'error_1794501328606', object: 'chat.completion.chunk', created: 1794501328,
          model: 'deepseek/deepseek-v4.1-flash', provider: 'unknown',
          error: { code: 'INSUFFICIENT_BALANCE', message: 'Достигнут лимит по сумме' },
          trace_id: 'trace-spending-limit',
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
        })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
      })
      const response = await streamChatAgent({
        model: provider.chat('deepseek/deepseek-v4.1-flash'),
        modelId: 'deepseek/deepseek-v4.1-flash',
        messages: [message], runId: loggedRunId, logLevel: 'detailed',
        sessionId: session.id, turnId, turnRepository: turns,
      })
      const body = await response.text()

      expect(body).toContain('В polza.ai достигнут лимит расходов')
      expect(turns.getLastTurn(session.id)).toMatchObject({ status: 'failed', stopReason: 'provider_spending_limit' })
      expect((await sessions.getSession(session.id))?.status).toBe('failed')
      expect(await readDiagnosticEntry()).toMatchObject({
        status: 'failed', error: 'Достигнут лимит по сумме',
        errorDetails: { code: 'INSUFFICIENT_BALANCE', message: 'Достигнут лимит по сумме' },
      })
    } finally {
      db.close()
    }
  })

  it('reports a streamed provider context error instead of saving an empty answer', async () => {
    const provider = createOpenAI({
      apiKey: 'test-key', baseURL: 'https://provider.example/v1',
      fetch: async () => new Response(`data: ${JSON.stringify({
        id: 'error-context-1', object: 'chat.completion.chunk', created: 1794520058,
        model: 'deepseek/deepseek-chat-v3.1',
        error: {
          code: 'BAD_REQUEST', message: 'Некорректный запрос.',
          metadata: { raw: 'This endpoint\'s maximum context length is 163840 tokens. However, you requested about 164174 tokens.' },
        },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    })
    const response = await streamChatAgent({
      model: provider.chat('deepseek/deepseek-chat-v3.1'), modelId: 'deepseek/deepseek-chat-v3.1',
      messages: [userMessage('Продолжай')], runId: loggedRunId, logLevel: 'raw',
    })
    const body = await response.text()

    expect(body).toContain('Контекст модели')
    expect(await readDiagnosticEntry()).toMatchObject({
      status: 'failed', errorDetails: { code: 'BAD_REQUEST' },
      rawResponse: [{ error: { code: 'BAD_REQUEST' } }],
    })
  })

  it('keeps partial text and the original stream error with its cause', async () => {
    const model = new MockLanguageModelV3({ doStream: streamResult([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Начало ответа' },
      { type: 'error', error: new Error('stream disconnected', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) }) },
    ]) })
    const response = await streamChatAgent({
      model, modelId: 'mock-model', messages: [userMessage('Ответь')], runId: loggedRunId, logLevel: 'detailed',
    })
    await response.text()

    expect(await readDiagnosticEntry()).toMatchObject({
      status: 'failed', answer: 'Начало ответа', error: 'stream disconnected',
      errorDetails: { message: 'stream disconnected', cause: { message: 'socket closed', code: 'ECONNRESET' } },
    })
  })

  it('records actual raw chunks and provider response metadata and warnings', async () => {
    vi.stubGlobal('AI_SDK_LOG_WARNINGS', false)
    const model = new MockLanguageModelV3({ doStream: {
      stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [{ type: 'other', message: 'provider warning' }] },
        { type: 'raw', rawValue: { choices: [], trace: 'raw-chunk-1' } },
        { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Ответ' }, { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ] as LanguageModelV3StreamPart[] }),
      response: { headers: { 'x-request-id': 'req-success-1' } },
    } })
    const response = await streamChatAgent({
      model, modelId: 'mock-model', messages: [userMessage('Ответь')], runId: loggedRunId, logLevel: 'raw',
    })
    await response.text()

    expect(await readDiagnosticEntry()).toMatchObject({
      status: 'completed', rawResponse: [{ choices: [], trace: 'raw-chunk-1' }],
      response: { headers: { 'x-request-id': 'req-success-1' } },
      steps: [{ warnings: [{ type: 'other', message: 'provider warning' }], response: { headers: { 'x-request-id': 'req-success-1' } } }],
    })
  })

  it.each(['stop', 'error', 'content-filter'] as const)('marks an empty %s response explicitly', async (finishReason) => {
    const model = new MockLanguageModelV3({ doStream: streamResult([
      { type: 'stream-start', warnings: [] },
      { type: 'finish', finishReason: { unified: finishReason, raw: finishReason }, usage },
    ]) })
    const response = await streamChatAgent({
      model, modelId: 'mock-model', messages: [userMessage('Ответь')], runId: loggedRunId, logLevel: 'detailed',
    })
    await response.text()

    expect(await readDiagnosticEntry()).toMatchObject({
      status: finishReason === 'stop' ? 'empty_response' : 'failed', error: expect.any(String),
      response: { finishReason, rawFinishReason: finishReason },
    })
  })

  it('records cancellation and its reason instead of a successful empty response', async () => {
    const controller = new AbortController()
    const model = new MockLanguageModelV3({ doStream: async () => {
      controller.abort(new DOMException('Generation deadline exceeded', 'TimeoutError'))
      return streamTextResult('Поздний ответ')
    } })
    const response = await streamChatAgent({
      model, modelId: 'mock-model', messages: [userMessage('Ответь')], runId: loggedRunId, logLevel: 'detailed',
      abortSignal: controller.signal,
    })
    await response.text()

    expect(await readDiagnosticEntry()).toMatchObject({
      status: 'aborted', error: 'Generation deadline exceeded',
      errorDetails: { name: 'TimeoutError', message: 'Generation deadline exceeded' },
      diagnostics: { outcome: 'aborted', isAborted: true },
    })
  })

  it('logs consumer cancellation exactly once', async () => {
    const model = new MockLanguageModelV3({ doStream: {
      stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        controller.enqueue({ type: 'text-start', id: 't' })
        controller.enqueue({ type: 'text-delta', id: 't', delta: 'Частичный ответ' })
      } }),
    } })
    const response = await streamChatAgent({
      model, modelId: 'mock-model', messages: [userMessage('Ответь')], runId: loggedRunId, logLevel: 'detailed',
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    await vi.waitFor(async () => expect(await readDiagnosticEntry()).toMatchObject({
      status: 'aborted', error: expect.stringContaining('cancelled'),
      diagnostics: { isCancelled: true },
    }))
  })

  it('logs validation failures thrown before a response stream is created', async () => {
    const model = new MockLanguageModelV3({ doStream: streamTextResult('Ответ') })
    await expect(streamChatAgent({
      model, modelId: 'mock-model', messages: [{ id: 'broken', role: 'user', parts: [{ type: 'text', text: 42 }] } as unknown as UIMessage],
      runId: loggedRunId, logLevel: 'detailed',
    })).rejects.toThrow()

    expect(await readDiagnosticEntry()).toMatchObject({
      status: 'failed', error: expect.any(String), errorDetails: { message: expect.any(String) },
    })
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

    await expect(createChatAgent(model, createTestDiceTool(fixedDraw(2))).generate({
      prompt: 'Брось кубик',
      abortSignal: controller.signal,
    })).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
