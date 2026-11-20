import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  JsonValue, TaskActorContext, TaskCommand, TaskCommandEnvelope, TaskCommandResult, TaskErrorCode, TaskSnapshot, TaskView,
} from '../../shared/task'
import type { ExpectedAction } from '../../shared/workflow'
import { createWorkflowRepository } from '../workflows/repository'
import { assertJsonValue, canonicalJson, expectedActionSchema } from '../workflows/schema'
import { TaskError } from './errors'
import { createTaskRepository } from './repository'

type ArtifactSource = { content: JsonValue; sourceMessageIds: string[]; sourceToolCallIds: string[] }

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

function nonempty(content: JsonValue): boolean {
  if (typeof content === 'string') return content.trim() !== ''
  if (Array.isArray(content)) return content.some(nonempty)
  if (content !== null && typeof content === 'object') return Object.values(content).some(nonempty)
  return content !== null
}

function requireActive(task: TaskSnapshot): void {
  if (task.status === 'paused') reject('TASK_PAUSED', 'Task is paused')
  if (task.status === 'cancelled') reject('TASK_CANCELLED', 'Task is cancelled')
  if (task.status === 'done') reject('TASK_TERMINAL', 'Task is complete')
}

export function createTaskService(db: Database.Database, options: { now?: () => string; newId?: () => string } = {}) {
  const repository = createTaskRepository(db)
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
      || (taskId !== null && receipt.task_id !== null && receipt.task_id !== taskId) || receipt.receipt_json === null) {
      reject('OPERATION_CONFLICT', 'Operation ID already belongs to a different or unfinished command')
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

  function startTask(sessionId: string, goal: string, workflow: CreateInput['workflow'], timestamp: string) {
    let nodeId = null
    let nodeVisitId = null
    let stage = 'execution'
    let step = 'Выполнение задачи'
    let expected = goal ? agentResult : userInput
    if (workflow) {
      if (!workflow.id.trim() || !Number.isSafeInteger(workflow.version) || workflow.version < 1) {
        reject('INVALID_INPUT', 'A valid workflow version is required')
      }
      const version = workflows.get(workflow.id, workflow.version)
      if (!version) reject('NOT_FOUND', 'Workflow version was not found')
      const entry = version.definition.nodes.find(node => node.id === version.definition.entryNodeId)
      if (!entry) throw new Error('Published workflow is missing its entry node')
      nodeId = entry.id
      nodeVisitId = newId()
      stage = entry.stage
      step = entry.label
      expected = entry.expected
    }
    const id = newId()
    repository.insert({
      id, sessionId, task: goal || emptyGoal, status: 'active', nodeId, nodeVisitId, stage, step, expected,
      workflowId: workflow?.id ?? null, workflowVersion: workflow?.version ?? null, progress: '',
      createdAt: timestamp, updatedAt: timestamp,
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

  function saveArtifact(task: TaskSnapshot, key: string, type: 'note' | 'result',
    source: ArtifactSource, timestamp: string): string {
    const { content, sourceMessageIds, sourceToolCallIds } = source
    assertJsonValue(content)
    const contentJson = canonicalJson(content)
    if (Buffer.byteLength(contentJson, 'utf8') > maxArtifactBytes) reject('INVALID_INPUT', 'Task artifact is too large')
    const id = newId()
    repository.insertArtifact({
      id, taskId: task.id, key, type, content, sourceMessageIds, sourceToolCallIds,
      hash: hash(contentJson), createdAt: timestamp,
    }, contentJson)
    return id
  }

  function applyBasic(task: TaskSnapshot, command: TaskCommand, actor: TaskActorContext, timestamp: string) {
    const state = { task: task.task, status: task.status, stage: task.stage, expected: task.expected,
      progress: task.progress, resultArtifactId: task.result?.id ?? null, updatedAt: timestamp }
    const userOnly = command.type === 'pause' || command.type === 'resume' || command.type === 'cancel'
      || command.type === 'complete_basic'
    if (userOnly && actor.role !== 'user') reject('TRANSITION_NOT_ALLOWED', 'Action requires a user')
    if (task.status === 'done' || (task.status === 'cancelled' && userOnly)) {
      reject('TASK_TERMINAL', 'Task is terminal')
    }
    if (task.status === 'cancelled') reject('TASK_CANCELLED', 'Task is cancelled')

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
        if (task.workflowId) reject('TRANSITION_NOT_ALLOWED', 'Workflow commands are unavailable')
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
        if (task.workflowId) reject('TRANSITION_NOT_ALLOWED', 'Workflow commands are unavailable')
        requireActive(task)
        checkRecovery(task.sessionId, task)
        if (!artifactKey.test(command.key) || !Array.isArray(command.sourceMessageIds) || !Array.isArray(command.sourceToolCallIds)
          || !command.sourceMessageIds.every(id => typeof id === 'string') || !command.sourceToolCallIds.every(id => typeof id === 'string')
          || !repository.hasArtifactSources(task, command.sourceMessageIds, command.sourceToolCallIds)) {
          reject('INVALID_INPUT', 'Artifact key or sources are invalid')
        }
        const artifactId = saveArtifact(task, command.key, 'note', command, timestamp)
        return { state, type: 'artifact_submitted', details: { artifactId } }
      }
      case 'finish': {
        if (task.workflowId) reject('TRANSITION_NOT_ALLOWED', 'Workflow commands are unavailable')
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
        const resultArtifactId = saveArtifact(task, 'result', 'result', source, timestamp)
        return {
          state: { ...state, status: 'done' as const, stage: 'done', resultArtifactId },
          type: 'completed', details: { artifactId: resultArtifactId },
        }
      }
      default:
        return reject('TRANSITION_NOT_ALLOWED', 'Workflow commands are unavailable')
    }
  }

  const applyTransaction = db.transaction((taskId: string, envelope: TaskCommandEnvelope, actor: TaskActorContext): TaskCommandResult => {
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
      const replay = checkReplay(operationId, taskId, actor, inputHash)
      if (replay) return replay
    } catch (error) {
      if (error instanceof RangeError) return failure(new TaskError('INVALID_INPUT', 'Command input cannot be serialized'))
      if (!(error instanceof TaskError)) throw error
      return failure(error)
    }

    const task = getOwned(taskId, actor.sessionId)
    let mutation: ReturnType<typeof applyBasic>
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
      mutation = applyBasic(task, command, actor, now())
    } catch (error) {
      if (!(error instanceof TaskError)) throw error
      return deny(operationId, actor, inputHash, error, task, task?.id ?? null)
    }

    repository.update(task.id, expectedRevision, mutation.state)
    return accept(operationId, actor, inputHash, repository.get(task.id)!, mutation.type, mutation.details, mutation.resumeRequestId)
  })

  async function apply(taskId: string, envelope: TaskCommandEnvelope, actor: TaskActorContext): Promise<TaskCommandResult> {
    return applyTransaction.immediate(taskId, envelope, actor)
  }

  function view(taskId: string, sessionId: string): TaskView {
    const task = getOwned(taskId, sessionId)
    const actions: TaskView['actions'] = []
    const recoveryOperations = task ? repository.listRecoveryOperations(task.id) : []
    if (task?.status === 'active' || task?.status === 'paused') {
      const blocked = task.recovery === 'needs_review' || repository.hasUnresolvedOperations(sessionId)
      if (task.status === 'active') actions.push({ type: 'pause', label: 'Пауза' })
      else if (!blocked) actions.push({ type: 'resume', label: 'Продолжить задачу' })
      actions.push({ type: 'cancel', label: 'Отменить задачу' })
      if (!task.workflowId && !blocked) actions.push({ type: 'complete_basic', label: 'Завершить задачу' })
    }
    return { task, actions, approvals: [], validations: [], recoveryOperations }
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

  return { create: create.immediate, apply, view, reserveForTurn: reserveForTurn.immediate }
}
