import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { evaluateCheck } from '../server/tasks/checks'
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
  await task.denied({ type: 'transition', transitionId: 'shortcut' }, 'VALIDATION_REQUIRED')
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
  await task.denied({ type: 'transition', transitionId: 'shortcut' }, 'VALIDATION_REQUIRED')
  file = 'second'
  await service.apply(task.id, { ...envelope, operationId: 'second', expectedRevision: changed.revision }, actor)
  file = 'now different'
  clock = '2020-01-01'
  const complete = (id: string) => service.apply(task.id, { command: { type: 'transition', transitionId: 'shortcut' },
    expectedRevision: task.view().task!.revision, operationId: id }, actor)
  expect(await complete('finish')).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
  expect(task.view().validations.map(v => v.outcome)).toEqual(['passed', 'passed', 'failed'])
  expect(task.view().validations.at(-1)?.createdAt).toBe(clock)
  file = 'second'
  expect(await complete('again')).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
  expect(task.view().task?.status).toBe('active')
})
