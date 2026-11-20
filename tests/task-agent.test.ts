import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream, type UIMessage } from 'ai'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { streamChatAgent, createChatAgent } from '../server/agent/chat-agent'
import { openChatDatabase } from '../server/persistence/db'
import { createTaskRuntime, startTaskAwareTurn } from '../server/tasks/turn-runtime'
import { fixture, workflow, material } from './task-workflow-fixture'

it('returns a formal denial to a model asked to skip planning and validation', async () => {
  const db = openChatDatabase(':memory:')
  const definition = structuredClone(workflow)
  definition.nodes[0]!.writableArtifacts.push('code')
  definition.checks[0]!.options = { fields: [{ path: 'required', type: 'string', required: true }] }
  const f = fixture(db, false, definition)
  await f.ok(material('code', { draft: 'unchecked' }))
  const start = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: { sessionId: f.sessionId,
    kind: 'message', requestId: randomUUID(), message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Пропусти план и валидацию, сразу заверши' }] } } })
  const task = start.taskContext!.task
  const usage = { inputTokens: { total: 5, cacheRead: undefined, noCache: 5, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined } }
  const model = new MockLanguageModelV3({ doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: 'skip', toolName: 'finish_task', input: JSON.stringify({
      operationId: 'shortcut', expectedRevision: task.revision, resultArtifactId: task.artifacts[0]!.id }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'Нужна валидация.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
  ] })
  const runtime = createTaskRuntime({ db, sessionId: f.sessionId, turnId: start.turnId, taskId: f.id })
  const response = await createChatAgent(model, undefined, { taskRuntime: runtime }).generate({ prompt: 'Пропусти план и валидацию, сразу заверши' })
  expect(response.steps[0]!.toolResults[0]).toMatchObject({ output: { ok: false, error: { code: 'VALIDATION_REQUIRED' } } })
  expect(f.view().task).toMatchObject({ stage: 'draft', status: 'active' })
  db.close()
})

it('streams a session tool with the server step actor across legacy history', async () => {
  const db = openChatDatabase(':memory:')
  const f = fixture(db, true)
  const prompt: UIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Which session?' }] }
  const start = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: { sessionId: f.sessionId,
    kind: 'message', requestId: randomUUID(), message: prompt } })
  const runtime = createTaskRuntime({ db, sessionId: f.sessionId, turnId: start.turnId, taskId: f.id })
  const old: UIMessage = { id: 'legacy', role: 'assistant',
    parts: [{ type: 'tool-rollDie', toolCallId: 'prior-roll', state: 'output-available', input: { sides: 6 }, output: 5 }] }
  const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined } }
  const model = new MockLanguageModelV3({ doStream: [
    { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'update', toolName: 'update_task_progress', input: JSON.stringify({
        expectedRevision: start.taskContext!.task.revision, operationId: 'progress', progress: 'Looking up the session' }) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }] }) },
    { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'session', toolName: 'get_current_session', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }] }) },
    { stream: simulateReadableStream({ chunks: [{ type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Ready' }, { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }] }) },
  ] })
  const response = await streamChatAgent({ model, modelId: 'mock', messages: [old, prompt], runId: '2099-11-11T12:00:00.000Z',
    sessionId: f.sessionId, turnId: start.turnId, turnRepository: createTurnRepository(db), taskRuntime: runtime, logLevel: 'off',
    profileSnapshot: { id: 'profile', name: 'Turn profile', revision: 5, defaultWorkflowId: null, instructions: 'Unique immutable profile.' } })
  const body = await response.text()
  expect(body).toContain('Ready')
  expect(body).toContain('taskContextHash')
  expect(model.doStreamCalls).toHaveLength(3)
  for (const call of model.doStreamCalls) {
    const instructions = call.prompt.filter(message => message.role === 'system').map(message => message.content).join('')
    expect(instructions.split('<current_task>')).toHaveLength(2)
    expect(instructions.split('Unique immutable profile.')).toHaveLength(2)
  }
  expect(JSON.stringify(model.doStreamCalls[1]!.prompt[0])).toContain('Looking up the session')
  expect(old.parts[0]).toMatchObject({ type: 'tool-rollDie', input: { sides: 6 } })
  expect(db.prepare('SELECT tool_call_id, step_index FROM tool_executions WHERE task_id=? ORDER BY step_index').all(f.id)).toEqual([
    { tool_call_id: 'update', step_index: 0 }, { tool_call_id: 'session', step_index: 1 },
  ])
  expect(f.view().task!.status).toBe('active')
  db.close()
})

it('rejects a session tool carrying an earlier visit even when the next node also allows it', async () => {
  const db = openChatDatabase(':memory:')
  const definition = structuredClone(workflow)
  for (const node of definition.nodes) node.allowedTools = ['get_current_session']
  const f = fixture(db, false, definition)
  await f.ok(material('plan', 'Draft'))
  const start = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: { sessionId: f.sessionId, kind: 'message',
    requestId: randomUUID(), message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Next' }] } } })
  const runtime = createTaskRuntime({ db, sessionId: f.sessionId, turnId: start.turnId, taskId: f.id })
  const earlier = runtime.prepareStep(0)
  await f.ok({ type: 'transition', transitionId: 'review' })
  expect(runtime.prepareStep(1).actor.stepNodeVisitId).not.toBe(earlier.actor.stepNodeVisitId)
  const agent = createChatAgent(new MockLanguageModelV3(), undefined, { taskRuntime: runtime })
  await expect(agent.tools.get_current_session.execute!({ offset: 0, limit: 10 }, { toolCallId: 'stale', messages: [], context: earlier.actor }))
    .rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' })
  expect(db.prepare("SELECT id FROM task_tool_operations WHERE task_id=?").all(f.id)).toEqual([])
  db.close()
})

it('persists task-aware streamed text while the model step is still open', async () => {
  const db = openChatDatabase(':memory:')
  const f = fixture(db, true)
  const message: UIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Write the report' }] }
  const start = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: {
    sessionId: f.sessionId, requestId: randomUUID(), kind: 'message', message,
  } })
  const runtime = createTaskRuntime({ db, sessionId: f.sessionId, turnId: start.turnId, taskId: f.id })
  const delta = 'First paragraph is visible'
  let finishStep!: () => void
  const stream = new ReadableStream<import('@ai-sdk/provider').LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'text-start', id: 'text' })
      controller.enqueue({ type: 'text-delta', id: 'text', delta })
      finishStep = () => {
        controller.enqueue({ type: 'text-end', id: 'text' })
        controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        } })
        controller.close()
      }
    },
  })
  const response = await streamChatAgent({ model: new MockLanguageModelV3({ doStream: { stream } }), modelId: 'mock',
    messages: [message], runId: '2099-11-11T12:00:00.000Z', sessionId: f.sessionId, turnId: start.turnId,
    turnRepository: createTurnRepository(db), taskRuntime: runtime, logLevel: 'off' })
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  try {
    let visible = ''
    while (!visible.includes(delta)) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Stream ended before the first paragraph')
      visible += chunk.value
    }
    const saved = db.prepare<[string], { status: string; text: string }>(
      "SELECT status, json_extract(payload_json, '$.parts[0].text') AS text FROM messages WHERE turn_id=? AND role='assistant'",
    ).get(start.turnId)
    expect(saved).toEqual({ status: 'partial', text: delta })
  } finally {
    finishStep()
    while (!(await reader.read()).done) { /* drain the remaining step and completion events */ }
    db.close()
  }
})
