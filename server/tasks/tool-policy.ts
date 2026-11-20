import type Database from 'better-sqlite3'
import type { TaskActorContext } from '../../shared/task'
import { createWorkflowRepository } from '../workflows/repository'
import { createApprovalStore } from './approvals'
import { createArtifactStore } from './artifacts'
import { TaskError } from './errors'
import { createTaskRepository } from './repository'
import { workingTool } from './tool-registry'
import { hasApproval } from './workflow'

export function assertTaskExecutionAllowed(db: Database.Database, taskId: string, actor: TaskActorContext, mutating: boolean) {
  const repository = createTaskRepository(db)
  const task = repository.get(taskId)
  if (!task || task.sessionId !== actor.sessionId) throw new TaskError('NOT_FOUND', 'Task was not found')
  if (task.status === 'paused') throw new TaskError('TASK_PAUSED', 'Task is paused')
  if (task.status === 'cancelled') throw new TaskError('TASK_CANCELLED', 'Task is cancelled')
  if (task.status === 'done') throw new TaskError('TASK_TERMINAL', 'Task is complete')
  const turn = db.prepare<[string, string, string], { status: string; source_turn_id: string | null }>(
    'SELECT status, source_turn_id FROM turns WHERE id = ? AND session_id = ? AND task_id = ?',
  ).get(actor.turnId ?? '', actor.sessionId, taskId)
  if (actor.role !== 'agent' || turn?.status !== 'running' || actor.stepNodeVisitId !== task.nodeVisitId) {
    throw new TaskError('TRANSITION_NOT_ALLOWED', 'Tool requires the running turn and its prepared visit')
  }
  if (mutating && turn.source_turn_id !== null) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Continuation permits only reads')
  if (task.recovery !== 'clear' || repository.hasUnresolvedOperations(task.sessionId)) {
    throw new TaskError('RECOVERY_REVIEW_REQUIRED', 'A tool operation is unresolved')
  }
  return task
}

export function assertTaskToolAllowed(db: Database.Database, { taskId, toolName, actor }: {
  taskId: string; toolName: string; actor: TaskActorContext
}): void {
  const tool = workingTool(toolName)
  const task = assertTaskExecutionAllowed(db, taskId, actor, tool?.mutating ?? true)
  if (!tool) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Unknown working tool')
  if (!task.workflowId) return
  const workflow = createWorkflowRepository(db).get(task.workflowId, task.workflowVersion!)?.definition
  const node = workflow?.nodes.find(item => item.id === task.nodeId)
  if (!node?.allowedTools.includes(toolName)) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Tool is unavailable in this workflow node')
  if (node.requiredApprovalKeys.length) {
    const evidence = { artifacts: createArtifactStore(db).workflowArtifacts(taskId), approvals: createApprovalStore(db).list(taskId), validations: [] }
    if (!node.requiredApprovalKeys.every(key => hasApproval(task, evidence, key))) throw new TaskError('PLAN_APPROVAL_REQUIRED', 'Current approval required')
  }
}
