import type { ArtifactSlot, ExpectedAction } from './workflow'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ArtifactRef {
  id: string
  key: string
  type: ArtifactSlot['type']
  version: number
  hash: string
}

export interface TaskArtifact extends ArtifactRef {
  taskId: string
  content: JsonValue
  sourceMessageIds: string[]
  sourceToolCallIds: string[]
  createdAt: string
}

export interface TaskSnapshot {
  id: string
  sessionId: string
  task: string
  status: 'active' | 'paused' | 'done' | 'cancelled'
  workflowId: string | null
  workflowVersion: number | null
  nodeId: string | null
  nodeVisitId: string | null
  stage: string
  step: string
  expected: ExpectedAction
  progress: string
  revision: number
  artifacts: ArtifactRef[]
  result: ArtifactRef | null
  recovery: 'clear' | 'needs_review'
  createdAt: string
  updatedAt: string
}

export interface TaskActorContext {
  role: 'user' | 'agent' | 'system'
  sessionId: string
  turnId?: string
  stepNodeVisitId?: string | null
  stepIndex?: number
}

export type TaskCommand =
  | { type: 'update_progress'; progress: string; expected?: ExpectedAction }
  | { type: 'submit_artifact'; key: string; content: JsonValue; sourceMessageIds: string[]; sourceToolCallIds: string[] }
  | { type: 'transition'; transitionId: string }
  | { type: 'validate' }
  | { type: 'finish'; resultArtifactId?: string; resultText?: string }
  | { type: 'attach'; workflowId: string; version: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'complete_basic' }
  | { type: 'approve'; approvalId: string }
  | { type: 'resolve_recovery'; operationId: string; outcome: 'completed' | 'failed' }

export interface TaskCommandEnvelope {
  operationId: string
  expectedRevision: number
  command: TaskCommand
}

export type TaskCommandResult =
  | { ok: true; task: TaskSnapshot; resumeRequestId?: string }
  | { ok: false; error: { code: TaskErrorCode; message: string }; task: TaskSnapshot | null }

export type TaskErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'TASK_ALREADY_ACTIVE'
  | 'TASK_PAUSED'
  | 'TASK_CANCELLED'
  | 'TASK_TERMINAL'
  | 'STALE_TASK_REVISION'
  | 'TRANSITION_NOT_ALLOWED'
  | 'PLAN_APPROVAL_REQUIRED'
  | 'VALIDATION_REQUIRED'
  | 'RECOVERY_REVIEW_REQUIRED'
  | 'SESSION_RUNNING'
  | 'OPERATION_CONFLICT'
  | 'CONTEXT_LIMIT'

export interface TaskView {
  task: TaskSnapshot | null
  actions: Array<{ type: TaskCommand['type']; label: string; approvalId?: string; recoveryOperationId?: string }>
  approvals: Array<{ id: string; artifact: ArtifactRef; status: 'pending' | 'approved' | 'obsolete' }>
  validations: ValidationResult[]
  recoveryOperations: Array<{ id: string; toolName: string; status: string; path?: string; expectedHash?: string; observedHash?: string }>
}

export interface ValidationResult {
  id: string
  taskId: string
  checkId: string
  checkerVersion: 1
  nodeVisitId: string
  inputs: ArtifactRef[]
  outcome: 'passed' | 'failed' | 'error'
  details: JsonValue
  createdAt: string
}
