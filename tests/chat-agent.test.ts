import { randomInt } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { createChatAgent, streamChatAgent } from '../server/agent/chat-agent'
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
      }, createTestDiceTool(fixedDraw(17)))
      const chunks = (await response.text()).split('\n')
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(6)))

      expect(chunks.find(chunk => chunk.type === 'finish')?.messageMetadata).toEqual({
        durationMs: 3_500,
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      })
    } finally {
      clock.mockRestore()
    }
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
    })
    const chunks = (await response.text()).split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
    const metadata = chunks.find(chunk => chunk.type === 'finish')?.messageMetadata

    expect(metadata).toEqual({ durationMs: expect.any(Number), usage: {} })
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

  it('stops a looping model with an explicit error after ten steps', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doGenerate: async () => toolCallResult(`call-${++call}`),
    })

    await expect(createChatAgent(model, createTestDiceTool(fixedDraw(3))).generate({
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
