import { effectScope, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { useTasks } from '../composables/useTasks'
import { completedToolOutputs, currentResumeRequest, requestIdForMessage, taskRequest } from '../shared/task-ui'
import type { TaskView } from '../shared/task'

const view = (id: string) => ({ task: { id, status: 'paused', revision: 7 }, actions: [], approvals: [], validations: [], recoveryOperations: [] }) as unknown as TaskView

it('retries an ambiguous command with its original operation, task and revision', async () => {
  const api = vi.fn().mockResolvedValueOnce({ current: view('first'), items: [] })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ current: view('replacement'), items: [] })
    .mockResolvedValueOnce({ ok: true, task: view('first').task, resumeRequestId: 'resume-from-server' })
    .mockResolvedValueOnce({ current: view('replacement'), items: [] })
  const scope = effectScope()
  const tasks = scope.run(() => useTasks('dialogue', api))!
  await tasks.refresh()
  expect(await tasks.submitCommand('> /task resume')).toEqual({ handled: false })
  await expect(tasks.submitCommand('/task resume')).rejects.toThrow('offline')
  await tasks.refresh()
  const result = await tasks.retry()
  expect(api.mock.calls[3]).toEqual(api.mock.calls[1])
  expect(api.mock.calls[1]).toMatchObject(['/api/sessions/dialogue/task-command', {
    method: 'POST', query: { expectedTaskId: 'first' }, body: { expectedRevision: 7, text: '/task resume' },
  }])
  expect(result).toHaveProperty('resumeRequestId', 'resume-from-server')
  expect(requestIdForMessage({ kind: 'message', requestId: 'resume-from-server' })).toBe('resume-from-server')
  scope.stop()
})

it('ignores a late response from a previous dialogue', async () => {
  const session = ref('old')
  let resolveOld!: (value: unknown) => void
  const api = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce({ current: view('current'), items: [] })
  const scope = effectScope()
  const tasks = scope.run(() => useTasks(session, api))!
  const old = tasks.refresh()
  session.value = 'new'
  await tasks.refresh()
  resolveOld({ current: view('old'), items: [] })
  await old
  expect(tasks.view.value?.task?.id).toBe('current')
  scope.stop()
})

it('recovers the resume receipt when the command response arrives but its refresh fails', async () => {
  const active = view('first')
  active.task!.status = 'active'
  const result = { ok: true, task: active.task, resumeRequestId: 'durable-id' }
  const api = vi.fn().mockResolvedValueOnce({ current: view('first'), items: [] })
    .mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('refresh failed'))
    .mockResolvedValueOnce(result).mockResolvedValueOnce({ current: active, items: [] })
  const scope = effectScope()
  const tasks = scope.run(() => useTasks('dialogue', api))!
  await tasks.refresh()
  await expect(tasks.act({ type: 'resume' })).rejects.toThrow('Повторите действие')
  expect(await tasks.retry()).toEqual(result)
  expect(api.mock.calls[3]).toEqual(api.mock.calls[1])
  scope.stop()
})

it('refreshes for a completed tool output only once', () => {
  const seen = new Set<string>()
  const parts = [{ type: 'tool-finish_task', toolCallId: 'x', state: 'input-available' }]
  expect(completedToolOutputs(parts, seen)).toBe(false)
  parts[0]!.state = 'output-available'
  expect(completedToolOutputs(parts, seen)).toBe(true)
  expect(completedToolOutputs(parts, seen)).toBe(false)
})

it('keeps user actions pinned to the displayed task and approval version', () => {
  const command = { type: 'approve', approvalId: 'exact-plan-version' } as const
  expect(taskRequest('dialogue', view('old'), { kind: 'action', command }, 'op')).toEqual({
    url: '/api/tasks/old/actions', query: { sessionId: 'dialogue' },
    body: { command, expectedRevision: 7, operationId: 'op' },
  })
})

it('only follows a resume receipt while that task is still active', () => {
  const state = view('first')
  state.task!.status = 'active'
  const receipt = { ok: true as const, task: state.task!, resumeRequestId: 'one-turn' }
  expect(currentResumeRequest(receipt, state)).toEqual({ id: 'one-turn', taskId: 'first' })
  const other = view('second')
  other.task!.status = 'active'
  expect(currentResumeRequest(receipt, other)).toBeNull()
  state.task!.status = 'done'
  expect(currentResumeRequest(receipt, state)).toBeNull()
})
