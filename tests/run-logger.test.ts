import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendRunLogEntry, type RunLogEntry } from '../server/utils/run-logger'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-run-log-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    recursive: true,
    force: true,
  })))
})

function createEntry(level: RunLogEntry['level'], runId = '2026-11-09T12:00:00.000Z'): RunLogEntry {
  return {
    runId,
    level,
    question: 'Брось d6',
    answer: 'Выпало 4.',
    startedAt: '2026-11-09T12:00:01.000Z',
    completedAt: '2026-11-09T12:00:02.250Z',
    durationMs: 1250,
    usage: {
      inputTokens: 10,
      inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0 },
      outputTokens: 3,
      outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
      totalTokens: 13,
    },
    request: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Брось d6' }],
      apiKey: 'super-secret-api-key',
      baseURL: 'https://provider.example/v1?api_key=super-secret-api-key',
    },
    response: {
      finishReason: 'stop',
      rawFinishReason: 'stop',
      id: 'response-1',
      modelId: 'mock-model',
    },
    steps: [{
      stepNumber: 0,
      toolCalls: [{ toolName: 'rollDie', input: { sides: 6 } }],
      toolResults: [{ toolName: 'rollDie', result: { sides: 6, result: 4 } }],
    }],
    rawResponse: [{ choices: [{ delta: { content: 'Выпало 4.' } }] }],
  } as RunLogEntry
}

async function readRunLog(directory: string, runId = '2026-11-09T12:00:00.000Z') {
  return JSON.parse(await readFile(join(directory, `run-${runId}.json`), 'utf8')) as {
    requests: Array<Record<string, unknown>>
    [key: string]: unknown
  }
}

describe('appendRunLogEntry', () => {
  it('writes basic fields without request context', async () => {
    const directory = await createTemporaryDirectory()

    await appendRunLogEntry(createEntry('basic'), directory)

    expect(await readdir(directory)).toEqual(['run-2026-11-09T12:00:00.000Z.json'])
    const log = await readRunLog(directory)
    expect(log).toMatchObject({
      runId: '2026-11-09T12:00:00.000Z',
      level: 'basic',
      requests: [{
        question: 'Брось d6',
        answer: 'Выпало 4.',
        durationMs: 1250,
        usage: createEntry('basic').usage,
      }],
    })
    expect(log.requests[0]?.request).toBeUndefined()
    expect(log.requests[0]?.steps).toBeUndefined()
    expect(log.requests[0]?.rawResponse).toBeUndefined()
  })

  it('adds model context, steps, and tool results at the detailed level', async () => {
    const directory = await createTemporaryDirectory()

    await appendRunLogEntry(createEntry('detailed'), directory)

    const log = await readRunLog(directory)
    expect(log.requests[0]?.request).toEqual({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Брось d6' }],
    })
    expect(log.requests[0]?.response).toEqual(createEntry('detailed').response)
    expect(log.requests[0]?.steps).toEqual(createEntry('detailed').steps)
    expect(log.requests[0]?.rawResponse).toBeUndefined()
  })

  it('adds raw provider chunks only at the raw level', async () => {
    const directory = await createTemporaryDirectory()

    await appendRunLogEntry(createEntry('raw'), directory)

    const log = await readRunLog(directory)
    expect(log.requests[0]?.rawResponse).toEqual(createEntry('raw').rawResponse)
  })

  it('does not create a file when logging is disabled', async () => {
    const directory = await createTemporaryDirectory()

    await appendRunLogEntry(createEntry('off'), directory)

    expect(await readdir(directory)).toEqual([])
  })

  it('serializes concurrent appends to one run without losing either request', async () => {
    const directory = await createTemporaryDirectory()
    const first = createEntry('basic')
    const second = { ...createEntry('basic'), question: 'Брось d20', answer: 'Выпало 17.' }

    await Promise.all([
      appendRunLogEntry(first, directory),
      appendRunLogEntry(second, directory),
    ])

    const log = await readRunLog(directory)
    expect(log.requests).toHaveLength(2)
    expect(log.requests.map(request => request.question)).toEqual(['Брось d6', 'Брось d20'])
  })

  it('keeps different runs in separate files', async () => {
    const directory = await createTemporaryDirectory()
    const secondRunId = '2026-11-09T12:01:00.000Z'

    await Promise.all([
      appendRunLogEntry(createEntry('basic'), directory),
      appendRunLogEntry(createEntry('basic', secondRunId), directory),
    ])

    expect((await readdir(directory)).sort()).toEqual([
      'run-2026-11-09T12:00:00.000Z.json',
      'run-2026-11-09T12:01:00.000Z.json',
    ])
  })

  it('never serializes API keys or URLs containing keys', async () => {
    const directory = await createTemporaryDirectory()

    await appendRunLogEntry(createEntry('raw'), directory)

    const serialized = JSON.stringify(await readRunLog(directory))
    expect(serialized).not.toContain('super-secret-api-key')
    expect(serialized).not.toContain('api_key=')
  })
})
