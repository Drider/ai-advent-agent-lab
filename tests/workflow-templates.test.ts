import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskService } from '../server/tasks/commands'
import { createValidationFileReader } from '../server/tasks/validation'
import { createFileWorkspace } from '../server/tools/files/file-workspace'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createWorkflowRepository } from '../server/workflows/repository'
import { seedBuiltInWorkflows } from '../server/workflows/templates'
import { validateWorkflowDefinition } from '../server/workflows/schema'
import { fixture, material } from './task-workflow-fixture'
import type { JsonValue } from '../shared/task'

let db: ReturnType<typeof openChatDatabase>
beforeEach(() => { db = openChatDatabase(':memory:'); seedBuiltInWorkflows(db) })
afterEach(() => db.close())
function template(id: string) {
  return createWorkflowRepository(db).get(id)!.definition
}
function taskFor(id: string) {
  const definition = template(id)
  const task = fixture(db, true)
  const go = async (target: string) => {
    const edge = definition.transitions.find(e => e.from === task.view().task?.nodeId && e.to === target)!
    return task.ok({ type: 'transition', transitionId: edge.id }, edge.actor)
  }
  return { ...task, go, attach: () => task.ok({ type: 'attach', workflowId: id, version: 1 }, 'user') }
}
it('seeds validated definitions once, preserving published versions', () => {
  const repository = createWorkflowRepository(db)
  expect(repository.list().map(row => row.id).sort()).toEqual(['analytics', 'code', 'questionnaire'])
  for (const row of repository.list()) expect(validateWorkflowDefinition(template(row.id))).toEqual(template(row.id))
  const first = repository.get('code', 1)
  const second = repository.publish('code', 1, { ...template('code'), contextExports: ['plan'] })
  seedBuiltInWorkflows(db)
  expect(repository.get('code')).toEqual(second)
  expect(repository.get('code', 1)).toEqual(first)
})
it('requires every answer only after attaching the questionnaire', async () => {
  const basic = fixture(db, true)
  expect(await basic.ok({ type: 'finish', resultText: 'result' })).toMatchObject({ status: 'done' })
  const task = taskFor('questionnaire')
  await task.attach()
  await task.ok(material('answers', { goal: 'G', experience: 'E' }))
  await task.go('validate_answers')
  await task.ok({ type: 'validate' })
  expect(task.view().validations.at(-1)?.outcome).toBe('failed')
  await task.go('collect_answers')
  await task.ok(material('answers', { goal: 'G', experience: 'E', responseFormat: 'F' }))
  await task.go('validate_answers')
  await task.ok({ type: 'validate' })
  await task.go('answer_request')
  await task.ok(material('result', 'Here is the requested answer'))
  await task.go('validate_result')
  await task.ok({ type: 'validate' })
  expect(await task.go('done')).toMatchObject({ status: 'done', result: { key: 'result' } })
  expect(template('questionnaire').contextExports).toEqual(['answers'])
})
it('requires an approved plan and structurally valid files for the code result', async () => {
  const task = taskFor('code')
  await task.attach()
  await task.ok(material('plan', { text: 'Plan' }))
  await task.go('approve_plan')
  await task.ok({ type: 'approve', approvalId: task.view().approvals[0]!.id }, 'user')
  await task.ok(material('implementation', { language: 'ts', files: [{ path: 'a.ts' }] }))
  await task.go('validation')
  await task.ok({ type: 'validate' })
  expect(task.view().validations.some(v => v.outcome === 'failed')).toBe(true)
  await task.go('implementation')
  await task.ok(material('implementation', { language: 'ts', files: [{ path: 'a.ts', content: 'export {}' }] }))
  await task.go('validation')
  await task.ok({ type: 'validate' })
  expect(await task.go('done')).toMatchObject({ status: 'done', result: { key: 'implementation' } })
})
it('imports canonical analytics data only from a confirmed read in the collection visit', async () => {
  const task = taskFor('analytics')
  await task.attach()
  db.prepare(`INSERT INTO turns (id, task_id, session_id, request_id, position, status, model_id,
    agent_config_json, started_at, updated_at) VALUES ('turn', ?, ?, 'turn', 0, 'running', 'mock', '{}', '', '')`).run(task.id, task.sessionId)
  const turns = createTurnRepository(db)
  const data = { records: [{ value: 10 }, { value: 20 }] }
  function record(id: string, name: string, input: JsonValue, output: JsonValue) {
    turns.recordToolStart({ turnId: 'turn', toolCallId: id, name, stepIndex: 0, input })
    turns.recordToolEnd({ turnId: 'turn', toolCallId: id, output })
    db.prepare(`INSERT INTO task_tool_operations (id, task_id, node_visit_id, action_key, tool_name, input_hash,
      status, source_turn_id, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'hash', 'completed', 'turn', ?, '', '')`)
      .run(id, task.id, task.view().task!.nodeVisitId, id, name, JSON.stringify(output))
    db.prepare('UPDATE tool_executions SET task_id = ?, task_operation_id = ? WHERE tool_call_id = ?').run(task.id, id, id)
  }
  const read = (id: string, output: JsonValue) => record(id, 'read_file', { path: 'records.json' }, output)
  const output = { ok: true, data: { path: 'records.json', text: JSON.stringify(data, null, 2) } }
  read('previous', output)
  await task.ok(material('plan', { text: 'Calculate' }))
  await task.go('approve_plan')
  await task.ok({ type: 'approve', approvalId: task.view().approvals[0]!.id }, 'user')
  const submit = (id: string, content = data) => ({ ...material('dataset', content), sourceToolCallIds: [id] })
  await task.denied(submit('previous'), 'INVALID_INPUT')
  read('failed', { ok: false })
  await task.denied(submit('failed'), 'INVALID_INPUT')
  read('current', output)
  await task.denied(submit('current', { records: [{ value: 900 }] }), 'INVALID_INPUT')
  await task.ok(submit('current'))
  await task.go('report')
  const root = await mkdtemp(join(tmpdir(), 'task-report-'))
  try {
    const workspace = createFileWorkspace(root)
    const markdown = '## Данные\n10, 20\n## Результаты\n30\n## Выводы\nСреднее 15'
    const report = { sourceRefs: ['records.json'], count: 2, sum: 30, mean: 15, markdown, path: 'report.md' }
    const written = await workspace.writeFile('report.md', markdown)
    expect(written.ok).toBe(true)
    if (!written.ok) throw Error(written.error.code)
    record('wrong-write', 'write_file', { path: 'elsewhere.md', content: markdown }, { ok: true, data: { path: 'elsewhere.md' } })
    await task.ok({ ...material('report', report), sourceToolCallIds: ['wrong-write'] })
    await task.go('validation')
    const service = createTaskService(db, { readTextFile: createValidationFileReader(root) })
    const apply = (command: Parameters<typeof task.ok>[0], id: string) => service.apply(task.id,
      { command, expectedRevision: task.view().task!.revision, operationId: id }, { sessionId: task.sessionId, role: 'agent' })
    await apply({ type: 'validate' }, 'check-wrong-write')
    expect(task.view().validations.find(v => v.checkId === 'report_write')?.outcome).toBe('failed')
    await task.go('report')
    record('write', 'write_file', { path: report.path, content: markdown }, { ok: true, data: { ...written.data } })
    await task.ok({ ...material('report', report), sourceToolCallIds: ['write'] })
    await task.go('validation')
    await apply({ type: 'validate' }, 'check-report')
    const visit = task.view().task!.nodeVisitId
    const current = task.view().validations.filter(v => v.nodeVisitId === visit)
    expect(current.length).toBe(template('analytics').completionCheckIds.length)
    expect(current.every(v => v.outcome === 'passed')).toBe(true)
    const reportId = task.view().task!.artifacts.find(a => a.key === 'report')!.id
    const finish = { type: 'finish' as const, resultArtifactId: reportId }
    await writeFile(join(root, report.path), '\uFEFF' + markdown)
    expect(await apply(finish, 'changed-file')).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
    await writeFile(join(root, report.path), markdown)
    await apply({ type: 'validate' }, 'recheck-report')
    expect(await apply(finish, 'finish-report')).toMatchObject({ ok: true, task: { status: 'done', result: { id: reportId } } })
  } finally { await rm(root, { recursive: true, force: true }) }
})
