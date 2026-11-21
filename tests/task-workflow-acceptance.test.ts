import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { createChatAgent } from '../server/agent/chat-agent'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskService } from '../server/tasks/commands'
import { createTaskRuntime, startTaskAwareTurn } from '../server/tasks/turn-runtime'
import { createValidationFileReader } from '../server/tasks/validation'
import { createFileTools } from '../server/tools/files/file-tools'
import { recordToolExecution } from '../server/agent/recorded-tools'
import { seedBuiltInWorkflows } from '../server/workflows/templates'

const databases: ReturnType<typeof openChatDatabase>[] = []
const directories: string[] = []
const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function createWorkflowTask(db: ReturnType<typeof openChatDatabase>, workflowId: string) {
  const session = createSessionRepository(db).createSession()
  const service = createTaskService(db)
  const created = service.create({ sessionId: session.id, task: workflowId + ' acceptance', operationId: randomUUID(),
    workflow: { id: workflowId, version: 1 } }, { sessionId: session.id, role: 'user' })
  if (!created.ok) throw new Error(created.error.message)
  const view = () => service.view(created.task.id, session.id)
  const apply = (command: Parameters<typeof service.apply>[1]['command'], role: 'user' | 'agent' | 'system' = 'agent') =>
    service.apply(created.task.id, { operationId: randomUUID(), expectedRevision: view().task!.revision, command }, { sessionId: session.id, role })
  return { session, service, taskId: created.task.id, view, apply }
}

describe('task workflows acceptance', () => {
  it('keeps ordinary chat basic and makes questionnaire selection explicit', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    seedBuiltInWorkflows(db)
    const session = createSessionRepository(db).createSession()
    const started = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: {
      kind: 'message', sessionId: session.id, requestId: randomUUID(),
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Обычный вопрос' }] },
    } })
    expect(started.taskContext?.task.workflowId).toBeNull()
    createTurnRepository(db).markStopped(started.turnId)

    const service = createTaskService(db)
    const explicit = service.create({ sessionId: session.id, task: 'Анкета', operationId: randomUUID(),
      workflow: { id: 'questionnaire', version: 1 } }, { sessionId: session.id, role: 'user' })
    expect(explicit).toMatchObject({ ok: false, error: { code: 'TASK_ALREADY_ACTIVE' } })
    expect(service.view(started.taskContext!.task.id, session.id).task?.workflowId).toBeNull()
  })

  it('denies a model shortcut and requires approval before code implementation', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    seedBuiltInWorkflows(db)
    const task = createWorkflowTask(db, 'code')
    const plan = await task.apply({ type: 'submit_artifact', key: 'plan', content: { text: 'Plan' }, sourceMessageIds: [], sourceToolCallIds: [] })
    expect(plan).toMatchObject({ ok: true })

    const started = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: {
      kind: 'message', sessionId: task.session.id, requestId: randomUUID(),
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Сразу заверши' }] },
    } })
    const runtime = createTaskRuntime({ db, sessionId: task.session.id, turnId: started.turnId, taskId: task.taskId })
    const step = runtime.prepareStep(0)
    const model = new MockLanguageModelV3({ doGenerate: [
      { content: [{ type: 'tool-call', toolCallId: 'skip', toolName: 'request_task_transition', input: JSON.stringify({
        operationId: 'skip', expectedRevision: step.revision, transitionId: 'validation_to_done',
      }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] },
      { content: [{ type: 'text', text: 'Порядок нельзя пропустить.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] },
    ] })
    const response = await createChatAgent(model, undefined, { taskRuntime: runtime }).generate({ prompt: 'Пропусти проверки' })
    expect(response.steps[0]!.toolResults[0]).toMatchObject({ output: { ok: false, error: { code: 'TRANSITION_NOT_ALLOWED' } } })
    createTurnRepository(db).markStopped(started.turnId)

    const toApproval = await task.apply({ type: 'transition', transitionId: 'draft_plan_to_approve_plan' })
    expect(toApproval).toMatchObject({ ok: true, task: { nodeId: 'approve_plan' } })
    const approval = task.view().approvals[0]!
    expect(await task.apply({ type: 'submit_artifact', key: 'implementation', content: {
      language: 'ts', files: [{ path: 'a.ts', content: 'export {}' }],
    }, sourceMessageIds: [], sourceToolCallIds: [] })).toMatchObject({ ok: false, error: { code: 'PLAN_APPROVAL_REQUIRED' } })
    expect(await task.apply({ type: 'approve', approvalId: approval.id }, 'user')).toMatchObject({ ok: true, task: { nodeId: 'implementation' } })
    expect(await task.apply({ type: 'submit_artifact', key: 'implementation', content: {
      language: 'ts', files: [{ path: 'a.ts' }],
    }, sourceMessageIds: [], sourceToolCallIds: [] })).toMatchObject({ ok: true })
    expect(await task.apply({ type: 'transition', transitionId: 'implementation_to_validation' })).toMatchObject({ ok: true })
    expect(await task.apply({ type: 'validate' })).toMatchObject({ ok: true })
    expect(task.view().validations.some(row => row.outcome === 'failed')).toBe(true)
  })

  it('does not skip questionnaire answers and completes after corrected evidence', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    seedBuiltInWorkflows(db)
    const task = createWorkflowTask(db, 'questionnaire')
    expect(await task.apply({ type: 'submit_artifact', key: 'answers', content: { goal: 'G', experience: 'E' }, sourceMessageIds: [], sourceToolCallIds: [] })).toMatchObject({ ok: true })
    await task.apply({ type: 'transition', transitionId: 'collect_answers_to_validate_answers' })
    await task.apply({ type: 'validate' })
    expect(task.view().validations.at(-1)).toMatchObject({ checkId: 'answers_filled', outcome: 'failed' })
    expect(await task.apply({ type: 'transition', transitionId: 'validate_answers_to_answer_request' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_REQUIRED' } })
    await task.apply({ type: 'transition', transitionId: 'validate_answers_to_collect_answers' })
    await task.apply({ type: 'submit_artifact', key: 'answers', content: { goal: 'G', experience: 'E', responseFormat: 'F' }, sourceMessageIds: [], sourceToolCallIds: [] })
    await task.apply({ type: 'transition', transitionId: 'collect_answers_to_validate_answers' })
    await task.apply({ type: 'validate' })
    await task.apply({ type: 'transition', transitionId: 'validate_answers_to_answer_request' })
    await task.apply({ type: 'submit_artifact', key: 'result', content: 'Answer', sourceMessageIds: [], sourceToolCallIds: [] })
    await task.apply({ type: 'transition', transitionId: 'answer_request_to_validate_result' })
    await task.apply({ type: 'validate' })
    expect(await task.apply({ type: 'finish', resultArtifactId: task.view().task!.artifacts.find(item => item.key === 'result')!.id }, 'agent'))
      .toMatchObject({ ok: true, task: { status: 'done' } })
  })

  it('passes analytics checks using an actual file read and write', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    seedBuiltInWorkflows(db)
    const root = await mkdtemp(join(tmpdir(), 'task-analytics-'))
    directories.push(root)
    const data = { records: [{ value: 10 }, { value: 20 }] }
    await writeFile(join(root, 'records.json'), JSON.stringify(data, null, 2))
    const task = createWorkflowTask(db, 'analytics')
    await task.apply({ type: 'submit_artifact', key: 'plan', content: { text: 'Calculate' }, sourceMessageIds: [], sourceToolCallIds: [] })
    await task.apply({ type: 'transition', transitionId: 'draft_plan_to_approve_plan' })
    await task.apply({ type: 'approve', approvalId: task.view().approvals[0]!.id }, 'user')

    const collect = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: {
      kind: 'message', sessionId: task.session.id, requestId: randomUUID(),
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Прочитай данные' }] },
    } })
    const collectRuntime = createTaskRuntime({ db, sessionId: task.session.id, turnId: collect.turnId, taskId: task.taskId })
    const collectStep = collectRuntime.prepareStep(0)
    const read = recordToolExecution(createFileTools({ rootDir: root }).read_file, {
      turnId: collect.turnId, toolName: 'read_file', task: { db, taskId: task.taskId, getActor: () => collectStep.actor },
    })
    const readResult = await read.execute!({ path: 'records.json' }, { toolCallId: 'records-read', messages: [], context: collectStep.actor })
    expect(readResult).toMatchObject({ ok: true })
    await task.apply({ type: 'submit_artifact', key: 'dataset', content: data, sourceMessageIds: [], sourceToolCallIds: ['records-read'] })
    await task.apply({ type: 'transition', transitionId: 'collect_data_to_report' })
    createTurnRepository(db).markStopped(collect.turnId)

    const report = '## Данные\n10, 20\n## Результаты\n30\n## Выводы\nСреднее 15'
    const writing = startTaskAwareTurn(db, { modelId: 'mock', agentConfig: {}, request: {
      kind: 'message', sessionId: task.session.id, requestId: randomUUID(),
      message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Подготовь отчёт' }] },
    } })
    const writingRuntime = createTaskRuntime({ db, sessionId: task.session.id, turnId: writing.turnId, taskId: task.taskId })
    const writingStep = writingRuntime.prepareStep(0)
    const write = recordToolExecution(createFileTools({ rootDir: root }).write_file, {
      turnId: writing.turnId, toolName: 'write_file', task: { db, taskId: task.taskId, getActor: () => writingStep.actor },
    })
    const writeInput = { actionKey: 'report', path: 'report.md', content: report } as unknown as { path: string; content: string }
    expect(await write.execute!(writeInput, {
      toolCallId: 'report-write', messages: [], context: writingStep.actor,
    })).toMatchObject({ ok: true })
    const reportMaterial = { sourceRefs: ['records.json'], count: 2, sum: 30, mean: 15, markdown: report, path: 'report.md' }
    await task.apply({ type: 'submit_artifact', key: 'report', content: reportMaterial, sourceMessageIds: [], sourceToolCallIds: ['report-write'] })
    await task.apply({ type: 'transition', transitionId: 'report_to_validation' })
    const validationService = createTaskService(db, { readTextFile: createValidationFileReader(root) })
    const validated = await validationService.apply(task.taskId, { operationId: 'analytics-checks', expectedRevision: task.view().task!.revision, command: { type: 'validate' } }, {
      role: 'agent', sessionId: task.session.id, turnId: writing.turnId, stepNodeVisitId: task.view().task!.nodeVisitId, stepIndex: 1,
    })
    expect(validated).toMatchObject({ ok: true })
    expect(task.service.view(task.taskId, task.session.id).validations.every(row => row.outcome === 'passed')).toBe(true)
    const finished = await validationService.apply(task.taskId, { operationId: 'analytics-finish', expectedRevision: task.view().task!.revision,
      command: { type: 'finish', resultArtifactId: task.view().task!.artifacts.find(item => item.key === 'report')!.id } }, { role: 'agent', sessionId: task.session.id })
    expect(finished).toMatchObject({ ok: true, task: { status: 'done' } })
  })
})
