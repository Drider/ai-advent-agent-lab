import { nonempty } from './artifacts'
import type { ArtifactRef, TaskActorContext, TaskArtifact, TaskErrorCode, TaskSnapshot, TaskView, ValidationResult } from '../../shared/task'
import type { Guard, WorkflowDefinition } from '../../shared/workflow'

export interface WorkflowEvidence {
  artifacts: TaskArtifact[]
  approvals: TaskView['approvals']
  validations: ValidationResult[]
}

type Decision = { allowed: true; targetNodeId: string } | { allowed: false; code: TaskErrorCode }

function sameRef(left: ArtifactRef, right: ArtifactRef) {
  return left.id === right.id && left.key === right.key && left.type === right.type
    && left.version === right.version && left.hash === right.hash
}

export function currentArtifact(task: TaskSnapshot, evidence: WorkflowEvidence, key: string) {
  const ref = task.artifacts.find(item => item.key === key)
  return ref && evidence.artifacts.find(item => item.taskId === task.id && sameRef(ref, item))
}

export function hasApproval(task: TaskSnapshot, evidence: WorkflowEvidence, key: string) {
  const artifact = currentArtifact(task, evidence, key)
  return !!artifact && evidence.approvals.some(item => item.status === 'approved' && sameRef(item.artifact, artifact))
}

function checkOutcome(task: TaskSnapshot, definition: WorkflowDefinition, evidence: WorkflowEvidence, id: string) {
  const check = definition.checks.find(item => item.id === id)
  if (!check) return
  // Repository order is the durable SQLite insertion order, independent of the display clock.
  let latest: ValidationResult | undefined
  for (const row of evidence.validations) {
    if (row.taskId === task.id && row.checkId === id && row.nodeVisitId === task.nodeVisitId) latest = row
  }
  if (!latest || latest.checkerVersion !== 1 || latest.inputs.length !== check.artifactKeys.length) return
  const inputs = latest.inputs
  if (check.artifactKeys.every(key => {
    const artifact = currentArtifact(task, evidence, key)
    return artifact && inputs.some(ref => sameRef(ref, artifact))
  })) return latest.outcome
}

function guardError(task: TaskSnapshot, definition: WorkflowDefinition, evidence: WorkflowEvidence, guard: Guard): TaskErrorCode | null {
  switch (guard.kind) {
    case 'artifact_present':
      return currentArtifact(task, evidence, guard.artifactKey) ? null : 'TRANSITION_NOT_ALLOWED'
    case 'approval_current':
      return hasApproval(task, evidence, guard.artifactKey) ? null : 'PLAN_APPROVAL_REQUIRED'
    case 'checks_current':
      return guard.checkIds.length && guard.checkIds.every(id => checkOutcome(task, definition, evidence, id) === 'passed')
        ? null : 'VALIDATION_REQUIRED'
    case 'checks_failed_current':
      return guard.checkIds.some(id => {
        const outcome = checkOutcome(task, definition, evidence, id)
        return outcome === 'failed' || outcome === 'error'
      }) ? null : 'VALIDATION_REQUIRED'
  }
}

export function completionError(task: TaskSnapshot, definition: WorkflowDefinition, evidence: WorkflowEvidence): TaskErrorCode | null {
  const code = guardError(task, definition, evidence, { kind: 'checks_current', checkIds: definition.completionCheckIds })
  if (code) return code
  const result = currentArtifact(task, evidence, definition.resultArtifactKey)
  return result && nonempty(result.content) ? null : 'INVALID_INPUT'
}

export function evaluateTransition(task: TaskSnapshot, definition: WorkflowDefinition, transitionId: string,
  evidence: WorkflowEvidence, actor: TaskActorContext): Decision {
  if (task.sessionId !== actor.sessionId) return { allowed: false, code: 'NOT_FOUND' }
  if (task.status === 'paused') return { allowed: false, code: 'TASK_PAUSED' }
  if (task.status === 'cancelled') return { allowed: false, code: 'TASK_CANCELLED' }
  if (task.status === 'done') return { allowed: false, code: 'TASK_TERMINAL' }
  if (task.recovery !== 'clear') return { allowed: false, code: 'RECOVERY_REVIEW_REQUIRED' }

  const edge = definition.transitions.find(item => item.id === transitionId)
  const source = definition.nodes.find(node => node.id === task.nodeId)
  const target = definition.nodes.find(node => node.id === edge?.to)
  if (!task.workflowId || !task.nodeVisitId || !edge || !source || !target || edge.from !== task.nodeId
    || edge.actor !== actor.role || (actor.stepNodeVisitId !== undefined && actor.stepNodeVisitId !== task.nodeVisitId)) {
    return { allowed: false, code: 'TRANSITION_NOT_ALLOWED' }
  }
  if (target.kind === 'success') {
    const code = completionError(task, definition, evidence)
    if (code) return { allowed: false, code }
  }
  if (target.kind === 'approval' && !currentArtifact(task, evidence, target.expected.artifactKey ?? '')) {
    return { allowed: false, code: 'TRANSITION_NOT_ALLOWED' }
  }
  if (edge.event === 'approve' && (actor.role !== 'user' || source.kind !== 'approval'
    || !source.expected.artifactKey || !hasApproval(task, evidence, source.expected.artifactKey))) {
    return { allowed: false, code: 'PLAN_APPROVAL_REQUIRED' }
  }
  if ([...source.requiredApprovalKeys, ...target.requiredApprovalKeys].some(key => !hasApproval(task, evidence, key))
    || target.requiredApprovalKeys.some(key => edge.invalidateApprovalKeys.includes(key))) {
    return { allowed: false, code: 'PLAN_APPROVAL_REQUIRED' }
  }
  if (edge.event === 'checks_passed' || edge.event === 'checks_failed') {
    const kind = edge.event === 'checks_passed' ? 'checks_current' : 'checks_failed_current'
    const code = guardError(task, definition, evidence, { kind, checkIds: source.checkIds })
    if (code) return { allowed: false, code }
  }
  for (const guard of edge.guards) {
    const code = guardError(task, definition, evidence, guard)
    if (code) return { allowed: false, code }
  }
  return { allowed: true, targetNodeId: target.id }
}
