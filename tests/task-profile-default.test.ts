import { it, expect } from 'vitest'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'
import { startTaskAwareTurn } from '../server/tasks/turn-runtime'
import { taskHttp } from './helpers/task-http'
const api = taskHttp()
it('pins the selected profile default only for a new task, with stable replay and an explicit none override', async () => {
  const sessions = createSessionRepository(api.db)
  const profiles = createUserProfileRepository(api.db)
  const first = sessions.createSession().id
  const second = sessions.createSession().id
  const profile = profiles.getForSession(first)!
  const url = '/user-profiles/' + profile.id + '/workflow'
  const patch = (workflowId: string | null, expectedRevision: number) => api.request(url, { workflowId, expectedRevision }, 'PATCH')
  expect(profile.defaultWorkflowId).toBeNull()
  const create = { operationId: 'first', task: 'First', selection: 'profile_default' }
  const basic = await api.request('/sessions/' + first + '/tasks', create)
  expect(basic.json.task.workflowId).toBeNull()
  expect(await patch('code', 0)).toMatchObject({ status: 200, json: { defaultWorkflowId: 'code', revision: 1 } })
  expect((await patch(null, 0)).status).toBe(409)
  expect((await patch('missing', 1)).status).toBe(404)
  expect(await api.request('/sessions/' + first + '/tasks', create)).toEqual(basic)
  const turn = (sessionId: string) => startTaskAwareTurn(api.db, { request: { sessionId, requestId: crypto.randomUUID(),
    kind: 'message', message: { role: 'user', id: crypto.randomUUID(), parts: [{ type: 'text', text: 'Go' }] } }, modelId: 'mock', agentConfig: {} })
  expect(turn(first).taskContext!.task.workflowId).toBeNull()
  expect(turn(second).taskContext!.task).toMatchObject({ workflowId: 'code', workflowVersion: 1 })
  const third = sessions.createSession()
  expect((await api.request('/sessions/' + third.id + '/tasks', { ...create, operationId: 'third', selection: 'none' })).json.task.workflowId).toBeNull()
  expect((await patch(null, 1)).json.defaultWorkflowId).toBeNull()
})
