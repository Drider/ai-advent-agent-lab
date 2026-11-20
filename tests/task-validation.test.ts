import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { evaluateCheck, type ToolReceipt } from '../server/tasks/checks'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createSessionTools } from '../server/tools/sessions/session-tools'
import { runTaskValidation } from '../server/tasks/validation'
import { openChatDatabase } from '../server/persistence/db'
import { createTaskService } from '../server/tasks/commands'
import { parseWorkflowSource } from '../server/workflows/parse'
import { fixture, material, workflow } from './task-workflow-fixture'
import type { JsonValue, TaskArtifact } from '../shared/task'
import type { CheckDefinition } from '../shared/workflow'

const context = { toolResults: [], readTextFile: async () => '# Saved report' }
function item(key: string, content: JsonValue): TaskArtifact {
  return { key, content, id: key, type: 'note', createdAt: '', taskId: 'task', version: 1, hash: key,
    sourceMessageIds: [], sourceToolCallIds: ['source'] }
}
function numeric(metric: string): CheckDefinition {
  return { id: 'metric', kind: 'numeric', artifactKeys: ['dataset', 'report'], options: {
    datasetKey: 'dataset', recordsPath: 'records', valuePath: 'value', reportKey: 'report',
    metric, reportedPath: metric, tolerance: 1e-9,
  } }
}
it.each([
  ['sum', [10, 20], 30, 'passed'], ['sum', [10, 20], 31, 'failed'],
  ['count', [10, 20], 2, 'passed'], ['mean', [10, 20], 15, 'passed'],
  ['mean', [], 0, 'failed'], ['sum', [Infinity], 0, 'failed'], ['sum', [NaN], 0, 'failed'],
] as const)('checks %s of %s against %s', async (metric, values, claimed, outcome) => {
  const inputs = [item('dataset', { records: values.map(value => ({ value })) }), item('report', { [metric]: claimed })]
  expect((await evaluateCheck(numeric(metric), inputs, context)).outcome).toBe(outcome)
})
it('checks field bounds, required values, exact headings, file contents and checker errors', async () => {
  const fields: CheckDefinition = { id: 'fields', kind: 'fields', artifactKeys: ['report'],
    options: { fields: [{ path: 'score', type: 'number', required: true, min: 1, max: 3, enum: [1, 3] }] } }
  for (const [content, outcome] of [[{}, 'failed'], [{ score: 4 }, 'failed'], [{ score: 2 }, 'failed'], [{ score: 3 }, 'passed']] as const) {
    expect((await evaluateCheck(fields, [item('report', content)], context)).outcome).toBe(outcome)
  }
  const sections: CheckDefinition = { ...fields, kind: 'sections', options: { headings: ['Saved report'] } }
  const report = (markdown: string) => [item('report', { markdown, path: 'report.md' })]
  expect((await evaluateCheck(sections, report('Body mentions Saved report'), context)).outcome).toBe('failed')
  expect((await evaluateCheck(sections, report('## Saved report'), context)).outcome).toBe('passed')
  const file: CheckDefinition = { ...fields, kind: 'file_matches', options: { pathField: 'path', contentField: 'markdown' } }
  expect((await evaluateCheck(file, report('# Saved report'), context)).outcome).toBe('passed')
  expect((await evaluateCheck(file, report('# Different'), context)).outcome).toBe('failed')
  expect((await evaluateCheck(file, report('# Saved report'), { ...context, readTextFile: async () => { throw Error('unavailable') } })).outcome).toBe('error')
})
it('only accepts a successful tool output named in the artifact sources', async () => {
  const check: CheckDefinition = { id: 'tool', kind: 'tool_success', artifactKeys: ['report'], options: { toolName: 'read_file' } }
  const input = item('report', { title: 'x' })
  for (const [toolCallId, ok, outcome] of [['other', true, 'failed'], ['source', false, 'failed'], ['source', true, 'passed']] as const) {
    const toolResults = [{ toolCallId, name: 'read_file', output: { ok, data: { path: 'records.json', text: '[]' } } }]
    expect((await evaluateCheck(check, [input], { ...context, toolResults })).outcome).toBe(outcome)
  }
})
it('rejects nested arrays in an array of structured implementation files', async () => {
  const check: CheckDefinition = { id: 'files', kind: 'fields', artifactKeys: ['code'],
    options: { fields: [{ path: 'files.path', type: 'string', required: true }] } }
  const code = item('code', { files: [[{ path: 'malformed' }]] })
  expect((await evaluateCheck(check, [code], context)).outcome).toBe('failed')
})
it.each(['json', 'yaml'] as const)('rejects unknown options, unsafe paths and invalid tolerance in %s', format => {
  const invalid: Record<string, JsonValue>[] = [{ extra: true }, { valuePath: 'x.constructor' }, { tolerance: -1 }]
  for (const override of invalid) {
    const definition = structuredClone(workflow)
    definition.checks[0] = { ...numeric('sum'), id: 'structure', artifactKeys: ['plan', 'code'], options: { ...numeric('sum').options as Record<string, JsonValue>, ...override, datasetKey: 'plan', reportKey: 'code' } }
    expect(() => parseWorkflowSource(format === 'json' ? JSON.stringify(definition) : stringify(definition), format)).toThrow()
  }
})

let db: ReturnType<typeof openChatDatabase>
beforeEach(() => { db = openChatDatabase(':memory:') })
afterEach(() => db.close())
function fileTask() {
  const check: CheckDefinition = { id: 'structure', kind: 'file_matches', artifactKeys: ['code'], options: { pathField: 'path', contentField: 'text' } }
  const definition = structuredClone(workflow)
  definition.nodes[0]!.checkIds = ['structure']
  definition.nodes[0]!.writableArtifacts.push('code')
  definition.transitions.push({ id: 'rework', from: 'draft', to: 'draft', actor: 'agent', event: 'checks_failed',
    invalidateApprovalKeys: [], guards: [] })
  definition.checks = [check]
  return fixture(db, false, definition)
}

it('persists a checker error when the workspace file is missing and replays the public validation result', async () => {
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: randomUUID() + '.txt', text: 'expected' }))
  const input = { taskId: task.id, actor: { sessionId: task.sessionId, role: 'agent' as const }, expectedRevision: snapshot.revision,
    operationId: 'missing-file', checkIds: ['structure'] }
  const result = await runTaskValidation(db, input)
  expect(result.ok).toBe(true)
  expect(task.view().validations).toMatchObject([{ checkId: 'structure', outcome: 'error', inputs: snapshot.artifacts }])
  expect(await runTaskValidation(db, input)).toEqual(result)
  const completion = await task.service.apply(task.id, { command: { type: 'transition', transitionId: 'shortcut' },
    expectedRevision: task.view().task!.revision, operationId: 'missing-file-finish' }, input.actor)
  expect(completion).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
  expect(task.view().validations.map(v => v.outcome)).toEqual(['error', 'error'])
})

it('reserves inputs before I/O, prevents duplicate execution and rejects stale results atomically', async () => {
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: 'a.txt', text: 'A' }))
  let release!: (text: string) => void
  let reads = 0
  const service = createTaskService(db, { readTextFile: () => { reads++; return new Promise(resolve => { release = resolve }) } })
  const envelope = { command: { type: 'validate' as const }, expectedRevision: snapshot.revision, operationId: 'in-flight' }
  const run = () => service.apply(task.id, envelope, { sessionId: task.sessionId, role: 'agent' })
  const pending = run()
  expect(db.prepare('SELECT phase FROM task_commands WHERE operation_id = ?').get('in-flight')).toEqual({ phase: 'running' })
  expect(await run()).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
  expect(reads).toBe(1)
  await task.ok(material('code', { path: 'b.txt', text: 'B' }))
  release('A')
  const rejected = await pending
  expect(rejected).toMatchObject({ ok: false, error: { code: 'STALE_TASK_REVISION' } })
  expect(await run()).toEqual(rejected)
  expect(task.view().validations).toEqual([])
})

it.each(['transition', 'finish'] as const)('runs an earlier node’s global check during %s on the last visit', async kind => {
  const definition = structuredClone(workflow)
  definition.nodes[0]!.checkIds = ['global']
  definition.checks.push({ id: 'global', kind: 'fields', artifactKeys: ['plan'], options: { fields: [] } })
  definition.completionCheckIds = ['global', 'structure']
  const task = fixture(db, false, definition)
  await task.ok(material('plan', 'Plan'))
  await task.ok({ type: 'validate' })
  await task.ok({ type: 'transition', transitionId: 'review' })
  await task.ok({ type: 'approve', approvalId: task.view().approvals[0]!.id }, 'user')
  const built = await task.ok(material('code', 'result'))
  const resultArtifactId = built.artifacts.find(row => row.key === 'code')!.id
  const last = await task.ok({ type: 'transition', transitionId: 'verify' })
  const command = kind === 'finish' ? { type: kind, resultArtifactId } : { type: kind, transitionId: 'finish' }
  const done = await task.ok(command, 'system')
  expect(done.status).toBe('done')
  expect(task.view().validations.filter(row => row.nodeVisitId === last.nodeVisitId).map(row => [row.checkId, row.outcome]))
    .toEqual([['global', 'passed'], ['structure', 'passed']])
})

it('reclaims an expired reservation and fences an old worker while its replacement is running', async () => {
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: 'a', text: 'A' }))
  const finishReads: Array<(text: string) => void> = []
  const service = createTaskService(db, { readTextFile: () => new Promise(resolve => finishReads.push(resolve)) })
  const run = () => service.apply(task.id, { command: { type: 'validate' }, operationId: 'lease', expectedRevision: snapshot.revision },
    { role: 'agent', sessionId: task.sessionId })
  const old = run()
  db.prepare(`UPDATE task_events SET details_json = json_set(details_json, '$.leaseUntil', 0, '$.worker', 'retired-worker')
    WHERE type = 'validation_requested' AND operation_id = 'lease'`).run()
  const replacement = run()
  try {
    expect(finishReads).toHaveLength(2)
    finishReads[0]!('wrong')
    expect(await old).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
    expect(task.view().validations).toEqual([])
    expect(await run()).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
    finishReads[1]!('A')
    const result = await replacement
    expect(result.ok).toBe(true)
    expect(await run()).toEqual(result)
    expect(task.view().validations).toMatchObject([{ outcome: 'passed' }])
  } finally {
    for (const finish of finishReads) finish('A')
    await Promise.all([old, replacement])
  }
})

it('renews a live worker’s lease during a long read', async () => {
  vi.useFakeTimers()
  let finish!: (text: string) => void
  try {
    const task = fileTask()
    const snapshot = await task.ok(material('code', { path: 'a', text: 'A' }))
    const service = createTaskService(db, { readTextFile: () => new Promise(resolve => { finish = resolve }) })
    const run = () => service.apply(task.id, { command: { type: 'validate' }, operationId: 'long-read', expectedRevision: snapshot.revision },
      { role: 'agent', sessionId: task.sessionId })
    const pending = run()
    const expiry = () => db.prepare<[], { expiry: number }>(`SELECT json_extract(details_json, '$.leaseUntil') AS expiry
      FROM task_events WHERE operation_id = 'long-read' AND type = 'validation_requested'`).get()!.expiry
    const initialLease = expiry() - Date.now()
    await vi.advanceTimersByTimeAsync(initialLease + 1)
    expect(expiry()).toBeGreaterThan(Date.now())
    expect(await run()).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
    finish('A')
    expect((await pending).ok).toBe(true)
  } finally { vi.useRealTimers() }
})

it('retries an interrupted final commit without exposing partial evidence', async () => {
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: 'file', text: 'saved' }))
  const envelope = { command: { type: 'validate' as const }, operationId: 'recover', expectedRevision: snapshot.revision }
  const actor = { role: 'agent' as const, sessionId: task.sessionId }
  const service = createTaskService(db, { readTextFile: async () => 'saved' })
  db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE ON task_commands WHEN NEW.operation_id = 'recover'
    BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`)
  await expect(service.apply(task.id, envelope, actor)).rejects.toThrow('receipt unavailable')
  expect(task.view().validations).toEqual([])
  expect(task.view().task!.revision).toBe(snapshot.revision)
  db.exec('DROP TRIGGER fail_receipt')
  expect(await service.apply(task.id, { ...envelope, command: { type: 'pause' } }, actor)).toMatchObject({ error: { code: 'OPERATION_CONFLICT' } })
  expect(await service.apply(task.id, envelope, actor)).toMatchObject({ ok: true })
  expect(task.view().validations).toHaveLength(1)
  expect(task.view().task!.revision).toBe(snapshot.revision + 1)
})

it('binds validation to immutable versions and reruns all completion checks despite wall-clock rollback', async () => {
  const task = fileTask()
  let file = 'first'
  let clock = '2030-01-01'
  let reads = 0
  const service = createTaskService(db, { now: () => clock, readTextFile: async () => { reads++; return file } })
  const actor = { role: 'agent' as const, sessionId: task.sessionId }
  const first = await task.ok(material('code', { path: 'report.md', text: file }))
  const envelope = { command: { type: 'validate' as const }, operationId: 'validate', expectedRevision: first.revision }
  const passed = await service.apply(task.id, envelope, actor)
  expect(passed.ok).toBe(true)
  expect(await service.apply(task.id, envelope, actor)).toEqual(passed)
  expect(reads).toBe(1)
  expect(task.view().validations[0]).toMatchObject({ outcome: 'passed', inputs: first.artifacts, nodeVisitId: first.nodeVisitId })
  const changed = await task.ok(material('code', { path: 'report.md', text: 'second' }))
  const tryChanged = await service.apply(task.id, { command: { type: 'transition', transitionId: 'shortcut' },
    expectedRevision: changed.revision, operationId: 'finish-changed' }, actor)
  expect(tryChanged).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
  expect(task.view().validations.at(-1)).toMatchObject({ outcome: 'failed', inputs: changed.artifacts })
  file = 'second'
  await service.apply(task.id, { ...envelope, operationId: 'second', expectedRevision: task.view().task!.revision }, actor)
  file = 'now different'
  clock = '2020-01-01'
  const complete = (id: string) => service.apply(task.id, { command: { type: 'transition', transitionId: 'shortcut' },
    expectedRevision: task.view().task!.revision, operationId: id }, actor)
  expect(await complete('finish')).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
  expect(task.view().validations.map(v => v.outcome)).toEqual(['passed', 'failed', 'passed', 'failed'])
  expect(task.view().validations.at(-1)?.createdAt).toBe(clock)
  expect(task.view().task?.status).toBe('active')
  await task.ok({ type: 'transition', transitionId: 'rework' })
  file = 'second'
  expect(await complete('again')).toMatchObject({ ok: true, task: { status: 'done' } })
})

it.each([['original-call', false], ['new-call', false], ['original-call', true], ['new-call', true], ['continue', true]] as const)(
  'recovers validation in-process using %s after failure to record its error=%s', async (toolCallId, receiptUnavailable) => {
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: 'report', text: 'saved' }))
  const turns = createTurnRepository(db)
  const { turnId } = turns.beginUserTurn({ requestId: 'validate-turn', sessionId: task.sessionId, modelId: 'test',
    message: { id: 'm', role: 'user', parts: [] }, agentConfig: {} })
  db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(task.id, turnId)
  const actor = { role: 'agent' as const, turnId, sessionId: task.sessionId, stepNodeVisitId: snapshot.nodeVisitId }
  const envelope = { command: { type: 'validate' as const }, operationId: 'validate', expectedRevision: snapshot.revision }
  const read = vi.fn(async () => 'saved')
  const service = createTaskService(db, { readTextFile: read })
  db.exec("CREATE TRIGGER fail_check BEFORE INSERT ON task_validations BEGIN SELECT RAISE(ABORT, 'commit failed'); END")
  if (receiptUnavailable) db.exec(`
    CREATE TRIGGER fail_record BEFORE UPDATE ON tool_executions BEGIN SELECT RAISE(ABORT, 'record failed'); END;
    CREATE TRIGGER fail_marker BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'marker and lease unavailable'); END;
  `)
  await expect(service.apply(task.id, envelope, actor, { toolCallId: 'original-call' })).rejects.toThrow('commit failed')
  if (receiptUnavailable) db.exec('DROP TRIGGER fail_record; DROP TRIGGER fail_marker')
  if (!receiptUnavailable) expect(db.prepare("SELECT status FROM tool_executions WHERE tool_call_id = 'original-call'").get()).toEqual({ status: 'failed' })
  expect(task.view().validations).toEqual([])
  db.exec('DROP TRIGGER fail_check')
  if (toolCallId === 'continue') {
    turns.markStopped(turnId)
    expect(turns.assessContinuation(turnId)).toBe('safe')
    expect(db.prepare("SELECT status FROM tool_executions WHERE tool_call_id = 'original-call'").get()).toEqual({ status: 'failed' })
    expect(read).toHaveBeenCalledTimes(1)
    return
  }
  await expect(service.apply(task.id, { ...envelope, operationId: 'different' }, actor, { toolCallId: 'original-call' }))
    .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  let release!: (text: string) => void
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const retry = service.apply(task.id, envelope, actor, { toolCallId })
  try {
    const concurrent = await service.apply(task.id, { operationId: 'other', expectedRevision: 999,
      command: { type: 'update_progress', progress: 'Parallel note' } }, actor, { toolCallId: 'other' })
    expect(concurrent).toMatchObject({ ok: false, error: { code: 'STALE_TASK_REVISION' } })
    expect(db.prepare('SELECT status FROM tool_executions WHERE tool_call_id = ?').get(toolCallId)).toEqual({ status: 'running' })
  } finally { release?.('saved') }
  const result = await retry
  expect(result.ok).toBe(true)
  expect(await service.apply(task.id, envelope, actor, { toolCallId: 'replay' })).toEqual(result)
  expect(task.view().validations).toHaveLength(1)
  expect(read).toHaveBeenCalledTimes(2)
  turns.markStopped(turnId)
  expect(turns.assessContinuation(turnId)).toBe('safe')
})

it('distinguishes an empty session aggregate from failure to load all requested paths', async () => {
  const tools = createSessionTools({ rootDir: '/unavailable-session-root-' + randomUUID() })
  const check: CheckDefinition = { id: 'analysis', kind: 'tool_success', artifactKeys: ['report'], options: { toolName: 'analyze_sessions' } }
  for (const [paths, expected] of [[undefined, 'passed'], [['a.json', 'b.json'], 'failed']] as const) {
    const output = await tools.analyze_sessions.execute!({ groupBy: 'day', ...(paths && { paths: [...paths] }) },
      { toolCallId: 'source', messages: [], context: {} })
    const toolResults = [{ toolCallId: 'source', name: 'analyze_sessions', output: JSON.parse(JSON.stringify(output)) }]
    expect((await evaluateCheck(check, [item('report', {})], { ...context, toolResults })).outcome).toBe(expected)
    // The original on-disk format had no top-level success flag.
    const { ok: _ok, ...legacyOutput } = toolResults[0]!.output
    const oldReceipt: ToolReceipt = { ...toolResults[0]!, output: legacyOutput, input: paths ? { paths: [...paths] } : {} }
    expect((await evaluateCheck(check, [item('report', {})], { ...context, toolResults: [oldReceipt] })).outcome).toBe(expected)
  }
})

it('fences the receipt of an expired checker when the same call ID is already running again', async () => {
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: 'report', text: 'saved' }))
  const turns = createTurnRepository(db)
  const { turnId } = turns.beginUserTurn({ requestId: 'late-check', sessionId: task.sessionId, modelId: 'test',
    message: { id: 'm', role: 'user', parts: [] }, agentConfig: {} })
  db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(task.id, turnId)
  const reads: Array<(text: string) => void> = []
  const service = createTaskService(db, { readTextFile: () => new Promise(resolve => reads.push(resolve)) })
  const invoke = () => service.apply(task.id, { command: { type: 'validate' }, operationId: 'check',
    expectedRevision: snapshot.revision }, { role: 'agent', sessionId: task.sessionId, turnId,
    stepNodeVisitId: snapshot.nodeVisitId }, { toolCallId: 'call' })
  const old = invoke()
  db.exec("UPDATE task_events SET details_json = json_set(details_json, '$.leaseUntil', 0, '$.worker', 'retired-worker') WHERE type = 'validation_requested'")
  const replacement = invoke()
  try {
    expect(reads).toHaveLength(2)
    reads[0]!('old')
    await expect(old).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
    expect(db.prepare("SELECT status, output_json FROM tool_executions WHERE tool_call_id = 'call'").get())
      .toEqual({ status: 'running', output_json: null })
    reads[1]!('saved')
    await expect(replacement).resolves.toMatchObject({ ok: true })
    expect(task.view().validations).toMatchObject([{ outcome: 'passed' }])
  } finally {
    for (const release of reads) release('saved')
    await Promise.allSettled([old, replacement])
  }
})

it.each(['local', 'remote'])('preserves a live %s checker across missed renewals and an unrelated rejected command', async owner => {
  vi.useFakeTimers()
  const task = fileTask()
  const snapshot = await task.ok(material('code', { path: 'report', text: 'saved' }))
  const turns = createTurnRepository(db)
  const { turnId } = turns.beginUserTurn({ requestId: 'long-turn', sessionId: task.sessionId, modelId: 'test',
    message: { id: 'message', role: 'user', parts: [] }, agentConfig: {} })
  db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(task.id, turnId)
  const actor = { role: 'agent' as const, sessionId: task.sessionId, turnId, stepNodeVisitId: snapshot.nodeVisitId }
  let release!: (value: string) => void
  const read = vi.fn(async () => 'unexpected extra read')
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const service = createTaskService(db, { readTextFile: read })
  const envelope = { command: { type: 'validate' as const }, operationId: 'check', expectedRevision: snapshot.revision }
  const pending = service.apply(task.id, envelope, actor, { toolCallId: 'live' })
  try {
    if (owner === 'remote') db.exec("UPDATE task_events SET details_json = json_set(details_json, '$.worker', 'another-worker') WHERE type = 'validation_requested'")
    const expiry = () => db.prepare<[], { expiry: number }>(
      "SELECT json_extract(details_json, '$.leaseUntil') AS expiry FROM task_events WHERE type = 'validation_requested'",
    ).get()!.expiry
    db.exec("CREATE TRIGGER missed_renewal BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'temporarily unavailable'); END")
    await vi.advanceTimersByTimeAsync(expiry() - Date.now() + 1)
    expect(expiry()).toBeLessThan(Date.now())
    db.exec('DROP TRIGGER missed_renewal')
    const unrelated = await service.apply(task.id, { command: { type: 'update_progress', progress: 'Stale note' },
      expectedRevision: snapshot.revision - 1, operationId: 'other' }, actor, { toolCallId: 'other-call' })
    expect(unrelated).toMatchObject({ ok: false, error: { code: 'STALE_TASK_REVISION' } })
    expect(db.prepare("SELECT status FROM tool_executions WHERE tool_call_id = 'live'").get()).toEqual({ status: 'running' })
    if (owner === 'local') {
      const duplicate = await service.apply(task.id, envelope, actor, { toolCallId: 'duplicate' })
      expect(duplicate).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } })
      await expect(service.apply(task.id, envelope, actor, { toolCallId: 'live' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    }
    expect(task.view().task?.revision).toBe(snapshot.revision)
    release('saved')
    expect(await pending).toMatchObject({ ok: true, task: { revision: snapshot.revision + 1 } })
    expect(task.view().validations).toMatchObject([{ outcome: 'passed', inputs: snapshot.artifacts }])
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    release('saved')
    await pending
    vi.useRealTimers()
  }
})
