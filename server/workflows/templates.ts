import type Database from 'better-sqlite3'
import type { CheckDefinition, WorkflowDefinition, WorkflowNode, WorkflowTransition } from '../../shared/workflow'
import type { JsonValue } from '../../shared/task'
import { createWorkflowRepository } from './repository'

function work(id: string, label: string, key: string, approved = false, allowedTools: string[] = []): WorkflowNode {
  return { id, kind: 'work', stage: id, label, expected: { actor: 'agent', kind: 'artifact', label, artifactKey: key },
    allowedTools, writableArtifacts: [key], requiredApprovalKeys: approved ? ['plan'] : [], checkIds: [] }
}
function validation(id: string, label: string, checkIds: string[], approved = false): WorkflowNode {
  return { id, kind: 'validation', stage: id, label, expected: { actor: 'agent', kind: 'validation', label },
    allowedTools: [], writableArtifacts: [], requiredApprovalKeys: approved ? ['plan'] : [], checkIds }
}
const done: WorkflowNode = { id: 'done', kind: 'success', stage: 'done', label: 'Завершено',
  expected: { actor: 'agent', kind: 'result', label: 'Результат готов' }, allowedTools: [],
  writableArtifacts: [], requiredApprovalKeys: [], checkIds: [] }
const plan = work('draft_plan', 'Подготовить план', 'plan')
const approval: WorkflowNode = { id: 'approve_plan', kind: 'approval', stage: 'approval', label: 'Утвердить план',
  expected: { actor: 'user', kind: 'approval', label: 'Утвердить план', artifactKey: 'plan' }, allowedTools: [],
  writableArtifacts: [], requiredApprovalKeys: [], checkIds: [] }
function edge(from: string, to: string, event: WorkflowTransition['event'] = 'advance', artifactKey?: string): WorkflowTransition {
  return { id: from + '_to_' + to, from, to, event, actor: event === 'approve' ? 'user' : 'agent',
    invalidateApprovalKeys: to === 'draft_plan' ? ['plan'] : [], guards: artifactKey ? [{ kind: 'artifact_present', artifactKey }] : [] }
}

function fields(id: string, key: string, rules: [string, string][]): CheckDefinition {
  return { id, kind: 'fields', artifactKeys: [key], options: {
    fields: rules.map(([path, type]) => ({ path, type, required: true })),
  } }
}
const answers = fields('answers_filled', 'answers', [['goal', 'string'], ['experience', 'string'], ['responseFormat', 'string']])
const result = fields('result_present', 'result', [])
const questionnaire: WorkflowDefinition = {
  schemaVersion: 1, entryNodeId: 'collect_answers', resultArtifactKey: 'result',
  artifactSlots: [{ key: 'answers', type: 'answers' }, { key: 'result', type: 'result' }],
  nodes: [work('collect_answers', 'Собрать ответы', 'answers'), validation('validate_answers', 'Проверить ответы', [answers.id]),
    work('answer_request', 'Ответить на исходный запрос', 'result'),
    validation('validate_result', 'Проверить результат', [answers.id, result.id]), done],
  transitions: [edge('collect_answers', 'validate_answers', 'advance', 'answers'), edge('validate_answers', 'answer_request', 'checks_passed'),
    edge('validate_answers', 'collect_answers', 'checks_failed'), edge('answer_request', 'validate_result', 'advance', 'result'),
    edge('validate_result', 'answer_request', 'checks_failed'), edge('validate_result', 'done', 'checks_passed')],
  checks: [answers, result], completionCheckIds: [answers.id, result.id], contextExports: ['answers'],
}

const planFields = fields('plan_structure', 'plan', [['text', 'string']])
const implementation = fields('implementation_structure', 'implementation', [
  ['language', 'string'], ['files', 'array'], ['files.path', 'string'], ['files.content', 'string'],
])
const planEdges = [edge('draft_plan', 'approve_plan', 'advance', 'plan'), edge('approve_plan', 'draft_plan')]
const code: WorkflowDefinition = {
  schemaVersion: 1, entryNodeId: 'draft_plan', resultArtifactKey: 'implementation', contextExports: [],
  artifactSlots: [{ key: 'plan', type: 'plan' }, { key: 'implementation', type: 'implementation' }],
  nodes: [plan, approval, work('implementation', 'Подготовить реализацию', 'implementation', true),
    validation('validation', 'Проверить структуру кода', [planFields.id, implementation.id], true), done],
  transitions: [...planEdges, edge('approve_plan', 'implementation', 'approve'), edge('implementation', 'draft_plan'),
    edge('implementation', 'validation', 'advance', 'implementation'), edge('validation', 'implementation', 'checks_failed'),
    edge('validation', 'done', 'checks_passed')],
  checks: [planFields, implementation], completionCheckIds: [planFields.id, implementation.id],
}

function reportCheck(id: string, kind: CheckDefinition['kind'], options: JsonValue): CheckDefinition {
  return { id, kind, options, artifactKeys: ['report'] }
}
const metrics: CheckDefinition[] = ['count', 'sum', 'mean'].map(metric => ({
  id: 'report_' + metric, kind: 'numeric', artifactKeys: ['dataset', 'report'], options: {
    datasetKey: 'dataset', recordsPath: 'records', valuePath: 'value', reportKey: 'report', metric, reportedPath: metric, tolerance: 1e-9,
  },
}))
const analyticsChecks: CheckDefinition[] = [
  planFields, fields('dataset_structure', 'dataset', [['records', 'array'], ['records.value', 'number']]),
  { id: 'dataset_read', kind: 'tool_success', artifactKeys: ['dataset'], options: { toolName: 'read_file' } },
  fields('report_structure', 'report', [['sourceRefs', 'array'], ['count', 'number'], ['sum', 'number'],
    ['mean', 'number'], ['markdown', 'string'], ['path', 'string']]),
  reportCheck('report_sections', 'sections', { headings: ['Данные', 'Результаты', 'Выводы'] }),
  reportCheck('report_write', 'tool_success', { toolName: 'write_file' }),
  reportCheck('report_file', 'file_matches', { pathField: 'path', contentField: 'markdown' }), ...metrics,
]
const analyticsIds = analyticsChecks.map(check => check.id)
const analytics: WorkflowDefinition = {
  schemaVersion: 1, entryNodeId: 'draft_plan', resultArtifactKey: 'report', contextExports: [],
  artifactSlots: [{ key: 'plan', type: 'plan' }, { key: 'dataset', type: 'dataset' }, { key: 'report', type: 'report' }],
  nodes: [plan, approval, work('collect_data', 'Прочитать данные', 'dataset', true, ['read_file']),
    work('report', 'Подготовить отчёт', 'report', true, ['write_file']),
    validation('validation', 'Проверить данные и отчёт', analyticsIds, true), done],
  transitions: [...planEdges, edge('approve_plan', 'collect_data', 'approve'), edge('collect_data', 'report', 'advance', 'dataset'),
    edge('collect_data', 'draft_plan'), edge('report', 'draft_plan'), edge('report', 'collect_data'),
    edge('report', 'validation', 'advance', 'report'), edge('validation', 'report', 'checks_failed'), edge('validation', 'done', 'checks_passed')],
  checks: analyticsChecks, completionCheckIds: analyticsIds,
}
export function seedBuiltInWorkflows(db: Database.Database): void {
  const repository = createWorkflowRepository(db)
  db.transaction(() => {
    repository.seed('questionnaire', 'Анкета', questionnaire)
    repository.seed('code', 'Создание кода', code)
    repository.seed('analytics', 'Аналитический отчёт', analytics)
  }).immediate()
}
