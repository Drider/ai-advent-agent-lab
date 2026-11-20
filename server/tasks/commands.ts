import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  JsonValue, TaskActorContext, TaskArtifact, TaskCommand, TaskCommandEnvelope, TaskCommandResult, TaskErrorCode, TaskSnapshot, TaskView, ValidationResult,
} from '../../shared/task'
import type { ExpectedAction, WorkflowNode } from '../../shared/workflow'
import { createWorkflowRepository } from '../workflows/repository'
import { assertJsonValue, canonicalJson, expectedActionSchema } from '../workflows/schema'
import { createApprovalStore } from './approvals'
import { createArtifactStore, nonempty } from './artifacts'
import { completionError, currentArtifact, evaluateTransition, hasApproval } from './workflow'
import { TaskError } from './errors'
import { property } from './checks'
import { createValidationStore, executeTaskCommand, runTaskValidation, hasReadSource, type ValidationRun } from './validation'
import { createTaskRepository } from './repository'

type ArtifactSource = { content: JsonValue; sourceMessageIds: string[]; sourceToolCallIds: string[] }

type TaskState = Parameters<ReturnType<typeof createTaskRepository>['update']>[2]

class ChecksRequested {
  constructor(readonly ids: string[]) {}
}

interface Mutation {
  state: TaskState
  type: string
  details?: Record<string, JsonValue>
  resumeRequestId?: string
}

interface CreateInput {
  sessionId: string
  task: string
  operationId: string
  workflow?: { id: string; version: number } | null
}

interface ReserveInput {
  sessionId: string
  kind: 'message' | 'continue'
  requestId: string
  sourceTurnId?: string
  messageText: string
  workflow?: CreateInput['workflow']
}

const emptyGoal = 'Новая задача'
const userInput: ExpectedAction = { actor: 'user', kind: 'input', label: 'Уточнить задачу' }
const agentResult: ExpectedAction = { actor: 'agent', kind: 'result', label: 'Подготовить результат' }
const artifactKey = /^[a-z][a-z0-9_]{0,79}$/
const maxArtifactBytes = 16_384
const maxGoalLength = 500

function reject(code: TaskErrorCode, message: string): never {
  throw new TaskError(code, message)
}

function failure(error: TaskError, task: TaskSnapshot | null = null): TaskCommandResult {
  return { ok: false, error: { code: error.code, message: error.message }, task }
}

function hash(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}

function requireActive(task: TaskSnapshot): void {
  if (task.status === 'paused') reject('TASK_PAUSED', 'Task is paused')
  if (task.status === 'cancelled') reject('TASK_CANCELLED', 'Task is cancelled')
  if (task.status === 'done') reject('TASK_TERMINAL', 'Task is complete')
}

interface TaskServiceOptions { now?: () => string; newId?: () => string; readTextFile?: (path: string) => Promise<string> }

export function createTaskCommandRuntime(db: Database.Database, options: TaskServiceOptions = {}) {
  const repository = createTaskRepository(db)
  const artifacts = createArtifactStore(db)
  const approvals = createApprovalStore(db)
  const validations = createValidationStore(db)
  const workflows = createWorkflowRepository(db)
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? randomUUID

  function getOwned(taskId: string, sessionId: string): TaskSnapshot | null {
    const task = repository.get(taskId)
    return task?.sessionId === sessionId ? task : null
  }

  function checkReplay(
    operationId: string,
    taskId: string | null,
    actor: TaskActorContext,
    inputHash: string,
    originalInputHash?: string,
  ) {
    if (repository.isCleared(operationId)) reject('OPERATION_CONFLICT', 'Operation was cleared from history')
    const receipt = repository.getCommand(operationId)
    if (!receipt) return
    if (receipt.session_id !== actor.sessionId || receipt.actor !== actor.role
      || (receipt.input_hash !== inputHash && receipt.input_hash !== originalInputHash)
      || (taskId !== null && receipt.task_id !== null && receipt.task_id !== taskId)) {
      reject('OPERATION_CONFLICT', 'Operation ID already belongs to a different or unfinished command')
    }
    if (receipt.receipt_json === null) {
      if (validations.reclaim(operationId)) return
      reject('OPERATION_CONFLICT', 'Operation is running')
    }
    return JSON.parse(receipt.receipt_json) as TaskCommandResult
  }

  function checkSession(sessionId: string): void {
    if (!repository.getSession(sessionId)) reject('NOT_FOUND', 'Session was not found')
    if (repository.hasPendingClear(sessionId)) reject('SESSION_RUNNING', 'Session history cleanup is pending')
  }

  function checkRecovery(sessionId: string, task: TaskSnapshot | null): void {
    if (task?.recovery === 'needs_review' || repository.hasUnresolvedOperations(sessionId)) {
      reject('RECOVERY_REVIEW_REQUIRED', 'A tool operation requires recovery review')
    }
  }

  function checkTurnStart(sessionId: string, task: TaskSnapshot | null): void {
    checkSession(sessionId)
    if (repository.getSession(sessionId)?.status === 'running' || repository.hasRunningTurn(sessionId)) {
      reject('SESSION_RUNNING', 'Session has a running turn')
    }
    checkRecovery(sessionId, task)
  }

  function pinWorkflow(id: string, version: number) {
    if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(version) || version < 1) {
      reject('INVALID_INPUT', 'A valid workflow version is required')
    }
    const pinned = workflows.get(id, version)
    if (!pinned) reject('NOT_FOUND', 'Workflow version was not found')
    const entry = pinned.definition.nodes.find(node => node.id === pinned.definition.entryNodeId)
    if (!entry) throw new Error('Published workflow is missing its entry node')
    // New activations have no workflow material from which to create an approval request.
    if (entry.kind === 'approval') reject('TRANSITION_NOT_ALLOWED', 'Approval entry requires current workflow material')
    return { workflowId: id, workflowVersion: version, ...position(entry) }
  }

  function position(node: WorkflowNode) {
    return { nodeId: node.id, nodeVisitId: newId(), stage: node.stage, step: node.label, expected: node.expected }
  }

  function startTask(sessionId: string, goal: string, workflow: CreateInput['workflow'], timestamp: string) {
    const initial = workflow ? pinWorkflow(workflow.id, workflow.version) : {
      workflowId: null, workflowVersion: null, nodeId: null, nodeVisitId: null,
      stage: 'execution', step: 'Выполнение задачи', expected: goal ? agentResult : userInput,
    }
    const id = newId()
    repository.insert({
      id, sessionId, task: goal || emptyGoal, status: 'active', ...initial,
      progress: '', createdAt: timestamp, updatedAt: timestamp,
    })
    return repository.get(id)!
  }

  function accept(operationId: string, actor: TaskActorContext, inputHash: string,
    task: TaskSnapshot, type: string, details?: Record<string, JsonValue>, resumeRequestId?: string): TaskCommandResult {
    const result: TaskCommandResult = { ok: true, task, ...(resumeRequestId !== undefined && { resumeRequestId }) }
    repository.saveCommand({ operationId, taskId: task.id, actor, inputHash, result, timestamp: task.updatedAt })
    repository.appendEvent({ id: newId(), task, operationId, actor, type, details })
    return result
  }

  function deny(operationId: string, actor: TaskActorContext, inputHash: string, error: TaskError,
    task: TaskSnapshot | null, taskId: string | null): TaskCommandResult {
    const result = failure(error, task)
    if (repository.getSession(actor.sessionId)) {
      repository.saveCommand({ operationId, taskId, actor, inputHash, result, timestamp: now() })
    }
    return result
  }

  const create = db.transaction((input: CreateInput, actor: TaskActorContext): TaskCommandResult => {
    const { operationId, sessionId } = input
    const workflow = input.workflow ?? null
    if (actor.sessionId !== sessionId || !operationId.trim()) {
      return failure(new TaskError('INVALID_INPUT', 'Command must belong to the actor session and have an operation ID'))
    }
    const inputHash = hash(canonicalJson({ type: 'create', task: input.task, workflow }))
    let existing: TaskSnapshot | null = null
    try {
      const replay = checkReplay(operationId, null, actor, inputHash)
      if (replay) return replay
    } catch (error) {
      if (!(error instanceof TaskError)) throw error
      return failure(error)
    }
    const goal = input.task.trim()
    let task: TaskSnapshot
    try {
      if (actor.role !== 'user') reject('TRANSITION_NOT_ALLOWED', 'Only a user can create a task explicitly')
      if (actor.turnId !== undefined) reject('INVALID_INPUT', 'Explicit task creation cannot belong to a turn')
      if (goal.length > maxGoalLength) reject('INVALID_INPUT', 'Task goal is too long')
      existing = repository.getUnfinished(sessionId)
      checkTurnStart(sessionId, existing)
      if (existing) reject('TASK_ALREADY_ACTIVE', 'Session already has an unfinished task')
      task = startTask(sessionId, goal, workflow, now())
    } catch (error) {
      if (!(error instanceof TaskError)) throw error
      return deny(operationId, actor, inputHash, error, existing, null)
    }
    return accept(operationId, actor, inputHash, task, 'created', { awaitingGoal: !goal })
  })

  function saveArtifact(task: TaskSnapshot, key: string, type: TaskArtifact['type'],
    source: ArtifactSource, timestamp: string, current: TaskArtifact | null | undefined): string {
    const { content, sourceMessageIds, sourceToolCallIds } = source
    assertJsonValue(content)
    const contentJson = canonicalJson(content)
    if (Buffer.byteLength(contentJson, 'utf8') > maxArtifactBytes) reject('INVALID_INPUT', 'Task artifact is too large')
    const digest = hash(contentJson)
    if (current?.type === type && current.hash === digest
      && JSON.stringify(current.sourceMessageIds) === JSON.stringify(sourceMessageIds)
      && JSON.stringify(current.sourceToolCallIds) === JSON.stringify(sourceToolCallIds)) return current.id
    const id = newId()
    repository.insertArtifact({
      id, taskId: task.id, key, type, content, sourceMessageIds, sourceToolCallIds,
      hash: digest, createdAt: timestamp,
    }, contentJson)
    return id
  }

  function checkArtifactSources(task: TaskSnapshot, command: Extract<TaskCommand, { type: 'submit_artifact' }>) {
    if (!artifactKey.test(command.key) || !Array.isArray(command.sourceMessageIds) || !Array.isArray(command.sourceToolCallIds)
      || !command.sourceMessageIds.every(id => typeof id === 'string') || !command.sourceToolCallIds.every(id => typeof id === 'string')
      || !repository.hasArtifactSources(task, command.sourceMessageIds, command.sourceToolCallIds)
      || (task.workflowId && !artifacts.afterActivation(task.id, command.sourceToolCallIds))) {
      reject('INVALID_INPUT', 'Artifact key or sources are invalid')
    }
  }

  function applyCommand(task: TaskSnapshot, command: TaskCommand, actor: TaskActorContext, timestamp: string): Mutation {
    const state: TaskState = { ...task, resultArtifactId: task.result?.id ?? null, updatedAt: timestamp }
    const userOnly = command.type === 'pause' || command.type === 'resume' || command.type === 'cancel'
      || command.type === 'complete_basic'
    if (userOnly && actor.role !== 'user') reject('TRANSITION_NOT_ALLOWED', 'Action requires a user')
    if (task.status === 'done' || (task.status === 'cancelled' && userOnly)) {
      reject('TASK_TERMINAL', 'Task is terminal')
    }
    if (task.status === 'cancelled') reject('TASK_CANCELLED', 'Task is cancelled')

    if (command.type === 'attach') {
      requireActive(task)
      if (actor.role !== 'user' || task.workflowId) reject('TRANSITION_NOT_ALLOWED', 'Only a user can attach a workflow to a basic task')
      checkTurnStart(task.sessionId, task)
      return { state: { ...state, ...pinWorkflow(command.workflowId, command.version) }, type: 'workflow_attached',
        details: { priorArtifactIds: task.artifacts.map(item => item.id),
          priorTurnPosition: repository.lastTurnPosition(task.sessionId) } }
    }

    if (task.workflowId && !userOnly) {
      requireActive(task)
      checkRecovery(task.sessionId, task)
      if (actor.stepNodeVisitId !== undefined && actor.stepNodeVisitId !== task.nodeVisitId) {
        reject('TRANSITION_NOT_ALLOWED', 'Workflow node visit changed')
      }
      if (command.type !== 'update_progress') return applyWorkflow(task, command, actor, state)
      if (command.expected !== undefined) reject('TRANSITION_NOT_ALLOWED', 'Expected action is defined by the pinned workflow')
    }

    switch (command.type) {
      case 'pause':
        requireActive(task)
        return { state: { ...state, status: 'paused' as const }, type: 'paused' }
      case 'resume':
        if (task.status !== 'paused') reject('TRANSITION_NOT_ALLOWED', 'Only a paused task can be resumed')
        checkTurnStart(task.sessionId, task)
        return { state: { ...state, status: 'active' as const }, type: 'resumed', resumeRequestId: newId() }
      case 'cancel':
        return { state: { ...state, status: 'cancelled' as const }, type: 'cancelled' }
      case 'complete_basic':
        if (task.workflowId) reject('TRANSITION_NOT_ALLOWED', 'A workflow task requires workflow completion')
        checkRecovery(task.sessionId, task)
        return { state: { ...state, status: 'done' as const, stage: 'done' }, type: 'completed' }
      case 'update_progress': {
        requireActive(task)
        checkRecovery(task.sessionId, task)
        if (typeof command.progress !== 'string' || command.progress.length > 2_000) {
          reject('INVALID_INPUT', 'Task progress must be a string of at most 2,000 characters')
        }
        const expected = command.expected ?? task.expected
        if (!expectedActionSchema.safeParse(expected).success) reject('INVALID_INPUT', 'Expected action is invalid')
        return { state: { ...state, progress: command.progress, expected }, type: 'progress_updated' }
      }
      case 'submit_artifact': {
        requireActive(task)
        checkRecovery(task.sessionId, task)
        checkArtifactSources(task, command)
        const artifactId = saveArtifact(task, command.key, 'note', command, timestamp, artifacts.latest(task.id, command.key))
        return { state, type: 'artifact_submitted', details: { artifactId } }
      }
      case 'finish': {
        requireActive(task)
        checkRecovery(task.sessionId, task)
        if (actor.role === 'agent' && task.expected.actor === 'user') {
          reject('TRANSITION_NOT_ALLOWED', 'Task is waiting for user input')
        }
        if ((command.resultText === undefined) === (command.resultArtifactId === undefined)) {
          reject('INVALID_INPUT', 'Specify exactly one result source')
        }
        if (command.resultText !== undefined && typeof command.resultText !== 'string'
          || command.resultArtifactId !== undefined && typeof command.resultArtifactId !== 'string') {
          reject('INVALID_INPUT', 'Result source must be a string')
        }
        const source = command.resultArtifactId !== undefined
          ? repository.getArtifact(task.id, command.resultArtifactId)
          : { content: command.resultText?.trim() ?? '', sourceMessageIds: [], sourceToolCallIds: [] }
        if (!source || !nonempty(source.content)) reject('INVALID_INPUT', 'Task result must be nonempty and belong to the task')
        const resultArtifactId = saveArtifact(task, 'result', 'result', source, timestamp, artifacts.latest(task.id, 'result'))
        return {
          state: { ...state, status: 'done' as const, stage: 'done', resultArtifactId },
          type: 'completed', details: { artifactId: resultArtifactId },
        }
      }
      default:
        return reject('TRANSITION_NOT_ALLOWED', 'Workflow commands are unavailable')
    }
  }

  function applyWorkflow(task: TaskSnapshot, command: TaskCommand, actor: TaskActorContext, state: TaskState): Mutation {
    const definition = workflows.get(task.workflowId!, task.workflowVersion!)!.definition
    const node = definition.nodes.find(item => item.id === task.nodeId)
    if (!node || !task.nodeVisitId) reject('TRANSITION_NOT_ALLOWED', 'Workflow position is invalid')
    const evidence = { artifacts: artifacts.workflowArtifacts(task.id), approvals: approvals.list(task.id),
      validations: repository.listValidations(task.id) }
    const at = state.updatedAt

    if (command.type === 'submit_artifact') {
      const slot = definition.artifactSlots.find(item => item.key === command.key)
      const writers = definition.nodes.filter(item => item.writableArtifacts.includes(command.key))
      if (!slot || !node.writableArtifacts.includes(command.key)) {
        if (writers.length && writers.every(item => item.requiredApprovalKeys.some(key => !hasApproval(task, evidence, key)))) {
          reject('PLAN_APPROVAL_REQUIRED', 'Writing this material requires a current approval')
        }
        reject('TRANSITION_NOT_ALLOWED', 'This node cannot write the requested artifact')
      }
      if (node.requiredApprovalKeys.some(key => !hasApproval(task, evidence, key))) {
        reject('PLAN_APPROVAL_REQUIRED', 'Current node requires an approved artifact')
      }
      checkArtifactSources(task, command)
      if (slot.type === 'dataset' && definition.checks.some(check => check.kind === 'tool_success'
        && check.artifactKeys.includes(slot.key) && property(check.options, 'toolName') === 'read_file')
        && !hasReadSource(command.content, artifacts.receipts(task.id, task.nodeVisitId, command.sourceToolCallIds))) {
        reject('INVALID_INPUT', 'Dataset must match a confirmed read from this visit')
      }
      const current = currentArtifact(task, evidence, slot.key)
      const artifactId = saveArtifact(task, slot.key, slot.type, command, at, current)
      if (artifactId !== current?.id) {
        if (node.kind === 'approval' && node.expected.artifactKey === slot.key) {
          approvals.request(newId(), task.id, artifactId, slot.key, task.nodeVisitId, at)
        } else {
          approvals.obsolete(task.id, slot.key, at)
        }
      }
      return { state, type: 'artifact_submitted', details: { artifactId, nodeVisitId: task.nodeVisitId } }
    }

    if (command.type === 'validate') {
      const ids = command.checkIds ?? node.checkIds
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !node.checkIds.includes(id))) {
        reject('TRANSITION_NOT_ALLOWED', 'Select checks assigned to the current node')
      }
      if (node.requiredApprovalKeys.some(key => !hasApproval(task, evidence, key))) {
        reject('PLAN_APPROVAL_REQUIRED', 'Validation requires a current approval')
      }
      return { state, type: 'validated', details: { checkIds: ids } }
    }

    let transitionId: string
    let approvalId: string | undefined
    if (command.type === 'approve') {
      if (actor.role !== 'user' || node.kind !== 'approval') reject('TRANSITION_NOT_ALLOWED', 'Approval requires a user at an approval node')
      const edges = definition.transitions.filter(edge => edge.from === node.id && edge.event === 'approve' && edge.actor === 'user')
      if (edges.length !== 1) reject('TRANSITION_NOT_ALLOWED', 'Approval node must have one user approval transition')
      const artifact = currentArtifact(task, evidence, node.expected.artifactKey ?? '')
      if (!artifact || !approvals.approve(command.approvalId, task.id, artifact.id, task.nodeVisitId, actor.turnId, at)) {
        reject('PLAN_APPROVAL_REQUIRED', 'Approval request is no longer current for this visit and artifact')
      }
      approvalId = command.approvalId
      evidence.approvals = approvals.list(task.id)
      transitionId = edges[0]!.id
    } else if (command.type === 'finish') {
      if (typeof command.resultArtifactId !== 'string' || command.resultText !== undefined) {
        reject('INVALID_INPUT', 'Workflow finish requires an exact result artifact ID')
      }
      const code = completionError(task, definition, evidence)
      if (code) reject(code, 'Current completion evidence is required')
      const result = currentArtifact(task, evidence, definition.resultArtifactKey)!
      if (result.id !== command.resultArtifactId) reject('INVALID_INPUT', 'Current task result is required')
      if (node.kind === 'success') {
        if (node.requiredApprovalKeys.some(key => !hasApproval(task, evidence, key))) {
          reject('PLAN_APPROVAL_REQUIRED', 'Completion requires a current approval')
        }
        return { state: { ...state, status: 'done', resultArtifactId: result.id }, type: 'completed', details: { artifactId: result.id } }
      }
      const edge = definition.transitions.find(edge => edge.from === node.id && edge.event !== 'approve'
        && definition.nodes.some(target => target.id === edge.to && target.kind === 'success')
        && evaluateTransition(task, definition, edge.id, evidence, actor).allowed)
      if (!edge) reject('TRANSITION_NOT_ALLOWED', 'No permitted transition to success')
      transitionId = edge.id
    } else if (command.type === 'transition') {
      transitionId = command.transitionId
      if (definition.transitions.some(edge => edge.id === transitionId && edge.event === 'approve')) {
        reject('TRANSITION_NOT_ALLOWED', 'Approval transition requires its user request')
      }
    } else {
      return reject('TRANSITION_NOT_ALLOWED', 'Command is unavailable for this workflow')
    }

    const decision = evaluateTransition(task, definition, transitionId, evidence, actor)
    if (!decision.allowed) reject(decision.code, 'Workflow transition requirements were not met')
    const target = definition.nodes.find(item => item.id === decision.targetNodeId)!
    const edge = definition.transitions.find(item => item.id === transitionId)!
    const next = position(target)
    for (const key of edge.invalidateApprovalKeys) approvals.obsolete(task.id, key, at)
    if (node.kind === 'approval' && !approvalId && node.expected.artifactKey) {
      approvals.obsolete(task.id, node.expected.artifactKey, at)
    }
    if (target.kind === 'approval') {
      const artifact = currentArtifact(task, evidence, target.expected.artifactKey!)!
      approvals.request(newId(), task.id, artifact.id, artifact.key, next.nodeVisitId, at)
    }
    const details: Record<string, JsonValue> = { transitionId, fromNodeId: node.id, fromNodeVisitId: task.nodeVisitId,
      toNodeId: target.id, toNodeVisitId: next.nodeVisitId }
    if (approvalId) details.approvalId = approvalId
    if (target.kind === 'success') {
      const result = currentArtifact(task, evidence, definition.resultArtifactKey)!
      return { state: { ...state, ...next, status: 'done', resultArtifactId: result.id }, type: 'completed',
        details: { ...details, artifactId: result.id } }
    }
    return { state: { ...state, ...next }, type: approvalId ? 'approved' : 'transitioned', details }
  }

  // A rejected command gets a receipt in the outer transaction. Roll back any tentative evidence writes first.
  const mutate = db.transaction((task: TaskSnapshot, command: TaskCommand, actor: TaskActorContext, timestamp: string,
    reserve: boolean) => {
    const mutation = applyCommand(task, command, actor, timestamp)
    if (reserve && task.workflowId && (mutation.type === 'validated' || mutation.state.status === 'done')) {
      const definition = workflows.get(task.workflowId, task.workflowVersion!)!.definition
      const node = definition.nodes.find(node => node.id === task.nodeId)!
      throw new ChecksRequested(command.type === 'validate' ? command.checkIds ?? node.checkIds : definition.completionCheckIds)
    }
    return mutation
  })

  const applyTransaction = db.transaction((taskId: string, envelope: TaskCommandEnvelope, actor: TaskActorContext,
    completed?: { run: ValidationRun; results: ValidationResult[] }): TaskCommandResult | ValidationRun => {
    const { operationId, expectedRevision, command } = envelope
    if (!operationId.trim()) return failure(new TaskError('INVALID_INPUT', 'Command requires an operation ID'))
    let inputHash: string
    try {
      if (repository.isCleared(operationId)) reject('OPERATION_CONFLICT', 'Operation was cleared from history')
      const input = {
        taskId, expectedRevision, turnId: actor.turnId ?? null,
        command: Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined)),
      }
      // Hash JSON data before enforcing artifact-specific constraints, so invalid artifacts get durable receipts.
      assertJsonValue(input, [], true)
      inputHash = hash(canonicalJson(input))
      if (!completed) {
        const replay = checkReplay(operationId, taskId, actor, inputHash)
        if (replay) return replay
      }
    } catch (error) {
      if (error instanceof RangeError) return failure(new TaskError('INVALID_INPUT', 'Command input cannot be serialized'))
      if (!(error instanceof TaskError)) throw error
      return failure(error)
    }

    const task = getOwned(taskId, actor.sessionId)
    if (completed && (!task || repository.getCommand(operationId)?.receipt_json !== null)) {
      return failure(new TaskError('OPERATION_CONFLICT', 'Validation reservation no longer exists'))
    }
    let mutation: Mutation
    try {
      checkSession(actor.sessionId)
      if (!task) reject('NOT_FOUND', 'Task was not found')
      if (actor.turnId !== undefined) {
        const turn = repository.getTurn(actor.turnId, actor.sessionId)
        if (turn?.task_id !== task.id || turn.status !== 'running') {
          reject('TRANSITION_NOT_ALLOWED', 'Turn is not running for this task')
        }
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) reject('INVALID_INPUT', 'Task revision is invalid')
      if (task.revision !== expectedRevision) reject('STALE_TASK_REVISION', 'Task revision changed')
      if (completed) {
        validations.verify(completed.run, operationId, task)
        requireActive(task)
        checkRecovery(task.sessionId, task)
        validations.persist(completed.results)
        if (command.type !== 'validate' && completed.results.some(row => row.outcome !== 'passed')) {
          const timestamp = now()
          repository.update(task.id, expectedRevision, { ...task, resultArtifactId: task.result?.id ?? null, updatedAt: timestamp })
          const updated = repository.get(task.id)!
          repository.appendEvent({ id: newId(), task: updated, operationId, actor, type: 'validated',
            details: { validationIds: completed.results.map(row => row.id) } })
          return deny(operationId, actor, inputHash, new TaskError('VALIDATION_REQUIRED', 'Completion checks did not pass'), updated, task.id)
        }
      }
      mutation = mutate(task, command, actor, now(), !completed)
      if (completed) mutation.details = { ...mutation.details, validationIds: completed.results.map(row => row.id) }
    } catch (error) {
      if (error instanceof ChecksRequested && task?.workflowId) {
        return validations.reserve(task, workflows.get(task.workflowId, task.workflowVersion!)!.definition,
          error.ids, actor, operationId, inputHash, now())
      }
      if (!(error instanceof TaskError)) throw error
      return deny(operationId, actor, inputHash, error, task, task?.id ?? null)
    }

    repository.update(task.id, expectedRevision, mutation.state)
    return accept(operationId, actor, inputHash, repository.get(task.id)!, mutation.type, mutation.details, mutation.resumeRequestId)
  })

  function view(taskId: string, sessionId: string): TaskView {
    const task = getOwned(taskId, sessionId)
    const actions: TaskView['actions'] = []
    const requests = task ? approvals.list(task.id) : []
    const validations = task ? repository.listValidations(task.id) : []
    const recoveryOperations = task ? repository.listRecoveryOperations(task.id) : []
    if (task?.status === 'active' || task?.status === 'paused') {
      const blocked = task.recovery === 'needs_review' || repository.hasUnresolvedOperations(sessionId)
      if (task.status === 'active') actions.push({ type: 'pause', label: 'Пауза' })
      else if (!blocked) actions.push({ type: 'resume', label: 'Продолжить задачу' })
      actions.push({ type: 'cancel', label: 'Отменить задачу' })
      if (task.status === 'active' && !blocked) {
        if (!task.workflowId && repository.getSession(sessionId)?.status !== 'running' && !repository.hasRunningTurn(sessionId)) {
          actions.push({ type: 'attach', label: 'Подключить процесс' })
        }
        const pending = requests.find(item => item.status === 'pending' && item.artifact.key === task.expected.artifactKey)
        if (task.expected.kind === 'approval' && pending) {
          actions.push({ type: 'approve', label: task.expected.label, approvalId: pending.id })
        }
      }
      if (!task.workflowId && !blocked) actions.push({ type: 'complete_basic', label: 'Завершить задачу' })
    }
    return { task, actions, approvals: requests, validations, recoveryOperations }
  }

  const reserveForTurn = db.transaction((input: ReserveInput, actor: TaskActorContext): TaskSnapshot | null => {
    const { sessionId, kind, requestId } = input
    if (actor.role !== 'system' || actor.sessionId !== sessionId || actor.turnId !== undefined || !requestId.trim()) {
      reject('INVALID_INPUT', 'Turn reservation requires the system context of the session')
    }
    const reservation = { type: 'reserve', messageText: input.messageText, workflow: input.workflow ?? null }
    const inputHash = hash(canonicalJson({ ...reservation, kind, sourceTurnId: input.sourceTurnId ?? null }))
    const originalInputHash = kind === 'message' && input.sourceTurnId === undefined
      ? hash(canonicalJson(reservation))
      : undefined
    const replay = checkReplay(requestId, null, actor, inputHash, originalInputHash)
    if (replay) {
      if (!replay.ok) reject(replay.error.code, replay.error.message)
      return replay.task
    }

    const task = repository.getUnfinished(sessionId)
    checkTurnStart(sessionId, task)
    if (kind === 'continue') {
      const source = input.sourceTurnId === undefined ? undefined : repository.getTurn(input.sourceTurnId, sessionId)
      if (!source) reject('NOT_FOUND', 'Source turn was not found')
      if (source.task_id === null) return null
      const continued = getOwned(source.task_id, sessionId)
      if (!continued) reject('NOT_FOUND', 'Task was not found')
      requireActive(continued)
      return continued
    }

    const goal = input.messageText.trim().slice(0, maxGoalLength)
    if (!task) {
      const created = startTask(sessionId, goal, input.workflow, now())
      accept(requestId, actor, inputHash, created, 'created', { awaitingGoal: !goal })
      return created
    }
    requireActive(task)
    const waitingForInput = !task.workflowId && task.expected.actor === 'user' && task.expected.kind === 'input'
    const hasTemporaryGoal = Boolean(goal) && repository.isAwaitingGoal(task)
    if (goal && (hasTemporaryGoal || waitingForInput)) {
      repository.update(task.id, task.revision, {
        ...task, task: hasTemporaryGoal ? goal : task.task, expected: waitingForInput ? agentResult : task.expected,
        resultArtifactId: task.result?.id ?? null, updatedAt: now(),
      })
      const updated = repository.get(task.id)!
      accept(requestId, actor, inputHash, updated, 'input_received')
      return updated
    }
    return task
  })

  return { create: create.immediate, transaction: applyTransaction.immediate, view, reserveForTurn: reserveForTurn.immediate,
    now, readTextFile: options.readTextFile }
}

export function createTaskService(db: Database.Database, options: TaskServiceOptions = {}) {
  const runtime = createTaskCommandRuntime(db, options)
  function apply(taskId: string, envelope: TaskCommandEnvelope, actor: TaskActorContext) {
    if (envelope.command.type === 'validate') {
      return runTaskValidation(db, { taskId, actor, checkIds: envelope.command.checkIds,
        operationId: envelope.operationId, expectedRevision: envelope.expectedRevision }, runtime)
    }
    return executeTaskCommand(runtime, taskId, envelope, actor)
  }
  return { create: runtime.create, view: runtime.view, reserveForTurn: runtime.reserveForTurn, apply }
}
