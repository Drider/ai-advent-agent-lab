import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeSessions, createSessionStore, createSessionTools, parseSessionLog } from '../server/tools/sessions'
import { createFileTools } from '../server/tools/files'

const directories: string[] = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function sessionFile(runId = '2026-11-09T12:00:00.000Z') {
  return JSON.stringify({
    runId,
    startedAt: runId,
    updatedAt: '2026-11-10T12:00:00.000Z',
    level: 'detailed',
    requests: [
      {
        question: 'Брось кубик', answer: '4', startedAt: '2026-11-09T12:00:00.000Z',
        completedAt: '2026-11-09T12:00:01.000Z', durationMs: 1000,
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        request: { model: 'model-a' },
        steps: [{ toolCalls: [{ toolName: 'rollDie' }, { toolName: 'rollDie' }] }],
      },
      {
        question: 'Привет', answer: 'Привет', startedAt: '2026-11-10T12:00:00.000Z',
        completedAt: '2026-11-10T12:00:02.000Z', durationMs: 2000,
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        request: { model: 'model-b' }, steps: [],
      },
    ],
  })
}

describe('session log parser and analysis', () => {
  it('parses this app’s log format and rejects unrelated JSON', () => {
    const session = parseSessionLog(sessionFile())
    expect(session.requests[0]).toMatchObject({
      model: 'model-a', tools: ['rollDie', 'rollDie'], totalTokens: 14,
    })
    expect(() => parseSessionLog('{"messages":[]}')).toThrow('не соответствует формату')
    expect(() => parseSessionLog('{')).toThrow('корректный JSON')
  })

  it('rejects oversized diagnostic strings in uploaded logs', () => {
    const log = JSON.parse(sessionFile())
    log.requests[0].diagnostics = { outcome: 'failed', finishReason: 'x'.repeat(1024 * 1024) }
    expect(() => parseSessionLog(JSON.stringify(log))).toThrow('не соответствует формату')
  })

  it('reads a request stopped by the step limit from a saved session log', () => {
    const log = JSON.parse(sessionFile())
    log.requests[0].status = 'step_limit'
    expect(parseSessionLog(JSON.stringify(log)).requests[0]?.status).toBe('step_limit')
  })

  it('filters and groups requests by date, model, tool, and session', () => {
    const session = parseSessionLog(sessionFile())
    expect(analyzeSessions([session], 'day').groups).toMatchObject([
      { key: '2026-11-09', requests: 1, totalTokens: 14, toolCalls: 2 },
      { key: '2026-11-10', requests: 1, totalTokens: 25, toolCalls: 0 },
    ])
    expect(analyzeSessions([session], 'model', { from: '2026-11-10' }).groups).toMatchObject([
      { key: 'model-b', requests: 1, totalTokens: 25 },
    ])
    expect(analyzeSessions([session], 'tool', { tool: 'rollDie' }).groups).toMatchObject([
      { key: 'rollDie', requests: 1, toolCalls: 2 },
    ])
    expect(analyzeSessions([session], 'session', { model: 'model-a' }).totals).toMatchObject({
      sessions: 1, requests: 1, inputTokens: 10,
    })
  })

  it('counts calls for each tool separately when a request uses multiple tools', () => {
    const session = parseSessionLog(sessionFile())
    session.requests[0]!.tools = ['rollDie', 'rollDie', 'read_file']
    expect(analyzeSessions([session], 'tool').groups).toMatchObject([
      { key: '(none)', toolCalls: 0 },
      { key: 'read_file', toolCalls: 1 },
      { key: 'rollDie', toolCalls: 2 },
    ])
  })

  it('marks missing model and tool details as unknown for basic logs', () => {
    const basic = JSON.parse(sessionFile())
    basic.level = 'basic'
    delete basic.requests[0].request
    delete basic.requests[0].steps
    const session = parseSessionLog(JSON.stringify(basic))
    expect(analyzeSessions([session], 'model').groups).toContainEqual(expect.objectContaining({ key: '(unknown)' }))
    expect(analyzeSessions([session], 'tool').groups).toContainEqual(expect.objectContaining({ key: '(unknown)' }))
  })
})

describe('session store and agent tools', () => {
  it('reports the active run before its first log entry is saved', async () => {
    const root = await temporaryDirectory()
    const runId = '2026-11-09T12:00:00.000Z'
    const tools = createSessionTools({
      rootDir: root,
      currentSession: { runId, modelId: 'model-a', logLevel: 'basic', currentQuestion: 'Что уже сохранено?' },
    })
    const context = { toolCallId: 'call-1', messages: [], context: {} }

    await expect(tools.get_current_session.execute({ offset: 0, limit: 10 }, context)).resolves.toMatchObject({
      ok: true,
      data: {
        runId,
        path: `runs/run-${runId}.json`,
        modelId: 'model-a',
        logLevel: 'basic',
        currentQuestion: 'Что уже сохранено?',
        currentRequestPersisted: false,
        saved: false,
        savedRequests: 0,
        entries: [],
      },
    })
  })

  it('reads only the exact active run and summarizes its saved requests', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'runs'))
    const runId = '2026-11-09T12:00:00.000Z'
    await writeFile(join(root, 'runs', `run-${runId}.json`), sessionFile(runId))
    await writeFile(join(root, 'runs', 'run-2026-11-10T13:00:00.000Z.json'), sessionFile('2026-11-10T13:00:00.000Z'))
    const tools = createSessionTools({
      rootDir: root,
      currentSession: { runId, modelId: 'model-b', logLevel: 'detailed', currentQuestion: 'Сколько токенов?' },
    })
    const context = { toolCallId: 'call-1', messages: [], context: {} }

    await expect(tools.get_current_session.execute({ query: 'привет', offset: 0, limit: 10 }, context)).resolves.toMatchObject({
      ok: true,
      data: {
        runId,
        saved: true,
        savedRequests: 2,
        matchingRequests: 1,
        entries: [{ index: 1, question: 'Привет' }],
        totals: { requests: 2, totalTokens: 39 },
        currentRequestPersisted: false,
      },
    })
  })

  it('loads local and existing imported files, deduplicates run IDs, and reports malformed files', async () => {
    const root = await temporaryDirectory()
    const runsDir = join(root, 'runs')
    const importsDir = join(root, 'imports')
    await mkdir(runsDir)
    await writeFile(join(runsDir, 'run-2026-11-09T12:00:00.000Z.json'), sessionFile())
    await writeFile(join(runsDir, 'run-2026-11-09T12:01:00.000Z.json'), '{')
    await mkdir(importsDir)
    await writeFile(join(importsDir, 'run-2026-11-09T12:00:00.000Z.json'), sessionFile())
    const store = createSessionStore({ runsDir, importsDir })
    const loaded = await store.loadSessions()
    expect(loaded.sessions).toHaveLength(1)
    expect(loaded.sessions[0]?.source).toBe('uploaded')
    expect(loaded.skippedFiles).toBe(1)
  })

  it('exposes list and aggregate tools to the agent', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'runs'))
    await writeFile(join(root, 'runs', 'run-2026-11-09T12:00:00.000Z.json'), sessionFile())
    const tools = createSessionTools({ rootDir: root })
    const context = { toolCallId: 'call-1', messages: [], context: {} }
    await expect(tools.list_sessions.execute({}, context)).resolves.toMatchObject({
      sessions: [{ requests: 2, models: ['model-a', 'model-b'], tools: ['rollDie'] }],
    })
    await expect(tools.analyze_sessions.execute({ groupBy: 'model' }, context)).resolves.toMatchObject({
      totals: { sessions: 1, requests: 2, totalTokens: 39 },
      groups: [{ key: 'model-a' }, { key: 'model-b' }],
    })
  })

  it('exposes failure diagnostics when reading a session and marks truncated error details', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'runs'))
    const path = 'runs/run-2026-11-09T12:00:00.000Z.json'
    const log = JSON.parse(sessionFile())
    Object.assign(log.requests[0], {
      status: 'failed', error: 'Maximum context length exceeded',
      errorDetails: { statusCode: 400, responseBody: 'provider details '.repeat(200) },
      diagnostics: { outcome: 'failed', stepCount: 0 },
    })
    await writeFile(join(root, path), JSON.stringify(log))
    const tools = createSessionTools({ rootDir: root })
    const context = { toolCallId: 'read-failure', messages: [], context: {} }

    const result = await tools.read_session_file.execute({ path, offset: 0, limit: 1 }, context)
    expect(result).toMatchObject({ ok: true, data: { entries: [{
      status: 'failed', error: 'Maximum context length exceeded',
      errorDetails: expect.stringContaining('"statusCode":400'), errorDetailsTruncated: true,
      diagnostics: { outcome: 'failed', stepCount: 0 },
    }] } })
    if ('ok' in result && result.ok) expect(result.data.entries[0]?.errorDetails?.length).toBeLessThanOrEqual(1000)
  })

  it('lets the agent find, read, and analyze a selected log larger than the regular text limit', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'runs'))
    const path = 'runs/run-2026-11-09T12:00:00.000Z.json'
    const log = JSON.parse(sessionFile())
    log.requests[0].question = 'кубик '.repeat(4000)
    await writeFile(join(root, path), JSON.stringify(log))
    await mkdir(join(root, 'archive'))
    await writeFile(join(root, 'archive', 'old.json'), sessionFile('2026-11-08T12:00:00.000Z'))
    const context = { toolCallId: 'call-1', messages: [], context: {} }
    const fileTools = createFileTools({ rootDir: root })
    const sessionTools = createSessionTools({ rootDir: root })

    await expect(sessionTools.list_sessions.execute({}, context)).resolves.toMatchObject({
      sessions: [{ path, runId: '2026-11-09T12:00:00.000Z' }],
    })

    await expect(fileTools.find_files.execute({ pattern: '**/run-*.json' }, context)).resolves.toMatchObject({
      ok: true, data: { paths: [path] },
    })
    await expect(fileTools.read_file.execute({ path }, context)).resolves.toMatchObject({
      ok: false, error: { code: 'TOO_LARGE' },
    })
    await expect(sessionTools.read_session_file.execute({ path, offset: 0, limit: 1 }, context)).resolves.toMatchObject({
      ok: true,
      data: { totalRequests: 2, hasMore: true, entries: [{ index: 0, questionTruncated: true }] },
    })
    await expect(sessionTools.read_session_file.execute({ path, query: 'привет', offset: 0, limit: 10 }, context)).resolves.toMatchObject({
      ok: true,
      data: { matchingRequests: 1, entries: [{ index: 1, question: 'Привет' }] },
    })
    await expect(sessionTools.analyze_sessions.execute({ groupBy: 'day', paths: [path] }, context)).resolves.toMatchObject({
      totals: { sessions: 1, requests: 2, totalTokens: 39 },
    })
    await expect(sessionTools.analyze_sessions.execute({ groupBy: 'day', paths: ['archive/old.json'] }, context)).resolves.toMatchObject({
      totals: { sessions: 1, requests: 2, totalTokens: 39 },
    })
  })

  it('rejects unsafe and invalid selected paths without exposing file contents', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'runs'))
    await writeFile(join(root, 'runs', 'bad.json'), '{')
    await symlink(join(root, 'runs', 'bad.json'), join(root, 'runs', 'link.json'))
    const tools = createSessionTools({ rootDir: root })
    const context = { toolCallId: 'call-1', messages: [], context: {} }

    await expect(tools.read_session_file.execute({ path: 'runs/bad.json', offset: 0, limit: 10 }, context)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    await expect(tools.read_session_file.execute({ path: 'runs/link.json', offset: 0, limit: 10 }, context)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_PATH' },
    })
    await expect(tools.analyze_sessions.execute({ groupBy: 'day', paths: ['../outside.json', 'runs/bad.json'] }, context)).resolves.toMatchObject({
      totals: { requests: 0 },
      skippedFiles: 2,
      fileErrors: [{ code: 'INVALID_PATH' }, { code: 'INVALID_INPUT' }],
    })
  })
})
