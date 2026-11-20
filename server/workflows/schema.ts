import { createHash } from 'node:crypto'
import { z } from 'zod'
import { checkOptions } from '../tasks/checks'
import type { JsonValue } from '../../shared/task'
import type { WorkflowDefinition } from '../../shared/workflow'
import { WorkflowSchemaError, type WorkflowSchemaIssue } from '../tasks/errors'
import type { FileTools } from '../tools/files'
import type { ModelConfigurationTools } from '../tools/model-configurations'
import type { SessionTools } from '../tools/sessions'
import type { UserProfileTools } from '../tools/user-profiles'

const MAX_WORKFLOW_BYTES = 65_536
export const MAX_WORKFLOW_DEPTH = 20

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const id = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)
const ids = z.array(id)
const label = z.string().min(1).max(200)
const actor = z.enum(['agent', 'user', 'system'])

type WorkingToolName = 'rollDie' | 'listSavedRolls' | 'save_memory'
  | keyof (FileTools & ModelConfigurationTools & SessionTools & UserProfileTools)

const workingTools = new Set(Object.keys({
  rollDie: true,
  listSavedRolls: true,
  save_memory: true,
  find_files: true,
  read_file: true,
  read_pdf: true,
  search_text: true,
  text_stats: true,
  write_file: true,
  get_current_session: true,
  list_sessions: true,
  read_session_file: true,
  analyze_sessions: true,
  save_model_configuration: true,
  list_model_configurations: true,
  delete_model_configuration: true,
  list_user_profiles: true,
  get_user_profile: true,
  create_user_profile: true,
  update_user_profile: true,
  select_user_profile: true,
} satisfies Record<WorkingToolName, true>))

export const expectedActionSchema = z.strictObject({
  actor,
  kind: z.enum(['input', 'artifact', 'approval', 'validation', 'result']),
  label,
  artifactKey: id.optional(),
})

const artifactSlotSchema = z.strictObject({
  key: id,
  type: z.enum(['plan', 'answers', 'dataset', 'implementation', 'report', 'result', 'note']),
})

const nodeSchema = z.strictObject({
  id,
  kind: z.enum(['work', 'approval', 'validation', 'success']),
  stage: label,
  label,
  expected: expectedActionSchema,
  allowedTools: z.array(z.string().refine(tool => workingTools.has(tool), 'Unknown working tool')),
  writableArtifacts: ids,
  requiredApprovalKeys: ids,
  checkIds: ids,
})

const guardSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('artifact_present'), artifactKey: id }),
  z.strictObject({ kind: z.literal('approval_current'), artifactKey: id }),
  z.strictObject({ kind: z.literal('checks_current'), checkIds: ids }),
  z.strictObject({ kind: z.literal('checks_failed_current'), checkIds: ids }),
])

const transitionSchema = z.strictObject({
  id,
  from: id,
  to: id,
  actor,
  event: z.enum(['advance', 'approve', 'checks_passed', 'checks_failed']),
  guards: z.array(guardSchema),
  invalidateApprovalKeys: ids,
})

const checkSchema = z.strictObject({
  id,
  kind: z.enum(['fields', 'sections', 'tool_success', 'file_matches', 'numeric']),
  artifactKeys: ids,
  // The JSON pass validates the contents. Require the options field here.
  options: z.custom<JsonValue>(value => value !== undefined, 'Expected check options'),
})

const workflowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entryNodeId: id,
  resultArtifactKey: id,
  artifactSlots: z.array(artifactSlotSchema).max(16),
  nodes: z.array(nodeSchema).max(64),
  transitions: z.array(transitionSchema).max(256),
  checks: z.array(checkSchema).max(32),
  completionCheckIds: ids.min(1),
  contextExports: ids,
})

export function workflowFieldPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((result, part) => {
    if (typeof part === 'number') return `${result}[${part}]`
    const key = String(part)
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
      ? `${result}.${key}`
      : `${result}[${JSON.stringify(key)}]`
  }, '$')
}

export function assertWorkflowSize(source: string): void {
  if (Buffer.byteLength(source, 'utf8') > MAX_WORKFLOW_BYTES) {
    throw new WorkflowSchemaError([{ path: '$', message: `Workflow must not exceed ${MAX_WORKFLOW_BYTES} UTF-8 bytes` }])
  }
}

export function assertJsonValue(
  value: unknown,
  path: (string | number)[] = [],
  forHash = false,
): asserts value is JsonValue {
  function reject(message: string, at = path): never {
    throw new WorkflowSchemaError([{ path: workflowFieldPath(at), message }])
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') reject('Expected a JSON value with finite numbers')
  if (!forHash && path.length >= MAX_WORKFLOW_DEPTH) {
    reject(`Workflow must have at most ${MAX_WORKFLOW_DEPTH} levels of nesting`)
  }

  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) reject('Expected a dense JSON array')
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, index)
      const field = forHash ? path : [...path, index]
      if (!property?.enumerable || !('value' in property)) reject('Expected a JSON array entry', field)
      assertJsonValue(property.value, field, forHash)
    }
    return
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) reject('Expected a JSON object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') reject('JSON object keys must be strings')
    const field = forHash ? path : [...path, key]
    if (!forHash && forbiddenKeys.has(key)) reject('This key is forbidden', field)
    const property = Object.getOwnPropertyDescriptor(value, key)!
    if (!property.enumerable || !('value' in property)) reject('Expected a JSON data property', field)
    assertJsonValue(property.value, field, forHash)
  }
}

function graphIssues(definition: WorkflowDefinition): WorkflowSchemaIssue[] {
  const issues: WorkflowSchemaIssue[] = []

  function add(path: (string | number)[], message: string) {
    issues.push({ path: workflowFieldPath(path), message })
  }

  function indexKeys<T>(items: T[], collection: string, field: keyof T & string): Set<string> {
    const keys = new Set<string>()
    items.forEach((item, index) => {
      const key = String(item[field])
      if (keys.has(key)) add([collection, index, field], `Duplicate ID "${key}"`)
      keys.add(key)
    })
    return keys
  }

  function checkReference(value: string, validKeys: Set<string>, path: (string | number)[]) {
    if (!validKeys.has(value)) add(path, `Unknown reference "${value}"`)
  }

  function checkReferences(values: string[], validKeys: Set<string>, path: (string | number)[]) {
    values.forEach((value, index) => checkReference(value, validKeys, [...path, index]))
  }

  const nodeIds = indexKeys(definition.nodes, 'nodes', 'id')
  const artifactKeys = indexKeys(definition.artifactSlots, 'artifactSlots', 'key')
  const checkIds = indexKeys(definition.checks, 'checks', 'id')
  indexKeys(definition.transitions, 'transitions', 'id')

  checkReference(definition.entryNodeId, nodeIds, ['entryNodeId'])
  checkReference(definition.resultArtifactKey, artifactKeys, ['resultArtifactKey'])
  checkReferences(definition.contextExports, artifactKeys, ['contextExports'])
  checkReferences(definition.completionCheckIds, checkIds, ['completionCheckIds'])

  definition.nodes.forEach((node, index) => {
    if (node.expected.artifactKey !== undefined) {
      checkReference(node.expected.artifactKey, artifactKeys, ['nodes', index, 'expected', 'artifactKey'])
    }
    checkReferences(node.writableArtifacts, artifactKeys, ['nodes', index, 'writableArtifacts'])
    checkReferences(node.requiredApprovalKeys, artifactKeys, ['nodes', index, 'requiredApprovalKeys'])
    checkReferences(node.checkIds, checkIds, ['nodes', index, 'checkIds'])
  })

  definition.transitions.forEach((transition, index) => {
    checkReference(transition.from, nodeIds, ['transitions', index, 'from'])
    checkReference(transition.to, nodeIds, ['transitions', index, 'to'])
    checkReferences(transition.invalidateApprovalKeys, artifactKeys, ['transitions', index, 'invalidateApprovalKeys'])
    transition.guards.forEach((guard, guardIndex) => {
      const path = ['transitions', index, 'guards', guardIndex]
      if ('artifactKey' in guard) {
        checkReference(guard.artifactKey, artifactKeys, [...path, 'artifactKey'])
      } else {
        checkReferences(guard.checkIds, checkIds, [...path, 'checkIds'])
      }
    })
  })

  definition.checks.forEach((check, index) => {
    const path = ['checks', index]
    checkReferences(check.artifactKeys, artifactKeys, [...path, 'artifactKeys'])
    if (!check.artifactKeys.length || new Set(check.artifactKeys).size !== check.artifactKeys.length) {
      add([...path, 'artifactKeys'], 'Expected distinct input artifact keys')
    }
    const options = checkOptions[check.kind].safeParse(check.options)
    if (!options.success) {
      for (const issue of options.error.issues) {
        const at = [...path, 'options', ...issue.path.map(part => typeof part === 'symbol' ? String(part) : part)]
        if (issue.code === 'unrecognized_keys') issue.keys.forEach(key => add([...at, key], 'Unknown option'))
        else add(at, issue.message)
      }
    } else if ('toolName' in options.data && !workingTools.has(options.data.toolName)) {
      add([...path, 'options', 'toolName'], 'Unknown working tool')
    } else if ('datasetKey' in options.data && (check.artifactKeys.length !== 2
      || options.data.datasetKey === options.data.reportKey
      || !check.artifactKeys.includes(options.data.datasetKey) || !check.artifactKeys.includes(options.data.reportKey))) {
      add([...path, 'artifactKeys'], 'Numeric checks require the dataset and report as distinct inputs')
    } else if ((check.kind === 'sections' || check.kind === 'file_matches') && check.artifactKeys.length !== 1) {
      add([...path, 'artifactKeys'], 'Expected one input artifact')
    }
  })

  if (issues.length) return issues

  const reachable = new Set<string>()
  const pending = [definition.entryNodeId]
  for (const nodeId of pending) {
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const transition of definition.transitions) {
      if (transition.from === nodeId) pending.push(transition.to)
    }
  }

  definition.nodes.forEach((node, index) => {
    if (!reachable.has(node.id)) add(['nodes', index, 'id'], `Node "${node.id}" is unreachable`)
  })
  if (!definition.nodes.some(node => node.kind === 'success' && reachable.has(node.id))) {
    add(['entryNodeId'], 'The initial node must reach a success node')
  }
  return issues
}

export function canonicalJson(value: JsonValue | WorkflowDefinition): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : Number(left > right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export function validateWorkflowDefinition(input: unknown): WorkflowDefinition {
  assertJsonValue(input)
  assertWorkflowSize(canonicalJson(input))

  const parsed = workflowSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap(issue => issue.code === 'unrecognized_keys'
      ? issue.keys.map(key => ({ path: workflowFieldPath([...issue.path, key]), message: 'Unknown field' }))
      : [{ path: workflowFieldPath(issue.path), message: issue.message }])
    throw new WorkflowSchemaError(issues)
  }

  const issues = graphIssues(parsed.data)
  if (issues.length) throw new WorkflowSchemaError(issues)
  return parsed.data
}

export function workflowHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex')
}
