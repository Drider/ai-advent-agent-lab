import type { TaskCommand, TaskCommandResult, TaskView, TaskWorkflowSelection } from './task'

export type TaskUiIntent =
  | { kind: 'command'; text: string }
  | { kind: 'action'; command: TaskCommand }
  | { kind: 'create'; task: string; selection: TaskWorkflowSelection }

export function taskRequest(sessionId: string, view: TaskView, intent: TaskUiIntent, operationId: string) {
  const session = '/api/sessions/' + encodeURIComponent(sessionId)
  const task = view.task
  if (intent.kind === 'create') {
    return { url: session + '/tasks', body: { operationId, task: intent.task, selection: intent.selection } }
  }
  if (intent.kind === 'command') {
    const unfinished = task && (task.status === 'active' || task.status === 'paused') ? task : null
    return { url: session + '/task-command', query: { expectedTaskId: unfinished?.id ?? 'none' },
      body: { operationId, expectedRevision: unfinished?.revision ?? 0, text: intent.text } }
  }
  if (!task) throw new Error('Задача ещё не создана.')
  return { url: '/api/tasks/' + encodeURIComponent(task.id) + '/actions', query: { sessionId },
    body: { operationId, expectedRevision: task.revision, command: intent.command } }
}

export function completedToolOutputs(parts: ReadonlyArray<{ type: string; toolCallId?: string; state?: string; preliminary?: boolean }>, seen: Set<string>) {
  let changed = false
  for (const part of parts) {
    if ((!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') || !part.toolCallId || part.preliminary) continue
    if (part.state !== 'output-available' && part.state !== 'output-error' && part.state !== 'output-denied') continue
    const key = part.toolCallId + '/' + part.state
    if (!seen.has(key)) {
      seen.add(key)
      changed = true
    }
  }
  return changed
}

export function requestIdForMessage(body?: Record<string, unknown>) {
  return body?.kind === 'message' && typeof body.requestId === 'string' ? body.requestId : crypto.randomUUID()
}

export function currentResumeRequest(result: TaskCommandResult, view: TaskView | null) {
  if (!result.ok || !result.resumeRequestId || view?.task?.id !== result.task.id || view.task.status !== 'active') return null
  return { id: result.resumeRequestId, taskId: result.task.id }
}
