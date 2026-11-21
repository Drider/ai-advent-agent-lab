import { it, expect } from 'vitest'
import { createSessionRepository } from '../server/persistence/session-repository'
import { startTaskAwareTurn } from '../server/tasks/turn-runtime'
import { fixture } from './task-workflow-fixture'
import { taskHttp } from './helpers/task-http'
import { deliverResume } from '../shared/resume-delivery'
const api = taskHttp()
const envelope = (command: object, expectedRevision = 0) => ({ operationId: crypto.randomUUID(), expectedRevision, command })
const text = (text: string, expectedRevision = 0) => ({ operationId: crypto.randomUUID(), expectedRevision, text })

it('restores a committed resume turn after a lost POST response without sending another turn', async () => {
  const { id } = createSessionRepository(api.db).createSession()
  const created = await api.request('/sessions/' + id + '/tasks', { operationId: 'start', task: 'First', selection: 'none' })
  const url = '/sessions/' + id + '/task-command'
  await api.request(url, text('/task pause'))
  const resumed = await api.request(url, text('/task resume', 1))
  const requestId = resumed.json.resumeRequestId
  const taskId = created.json.task.id
  let posts = 0
  let restored
  await deliverResume({
    send: async () => {
      posts++
      startTaskAwareTurn(api.db, { request: { kind: 'message', sessionId: id, requestId, resumeTaskId: taskId,
        message: { id: 'resumed-user-message', role: 'user', parts: [{ type: 'text', text: 'Continue' }] } }, modelId: 'mock', agentConfig: {} })
      throw new Error('Response lost after commit')
    },
    inspect: async () => (await api.request('/sessions/' + id + '?resumeRequestId=' + requestId + '&resumeTaskId=' + taskId)).json,
    restore: detail => { restored = detail },
  }, false)
  expect(posts).toBe(1)
  expect(restored).toMatchObject({ acceptedResumeTurn: true, lastTurn: { id: requestId }, messages: [{ id: 'resumed-user-message' }] })
  await deliverResume({
    send: async () => { throw new Error('Should not POST a second time after an ambiguous response') },
    inspect: async () => (await api.request('/sessions/' + id + '?resumeRequestId=' + requestId + '&resumeTaskId=' + taskId)).json,
    restore: detail => { restored = detail },
  }, true)
  expect(api.db.prepare('SELECT count(*) n FROM turns').get()).toEqual({ n: 1 })
})

it('attaches atomically to an empty dialogue and replays decisions after task turnover', async () => {
  const { id } = createSessionRepository(api.db).createSession()
  const tasks = '/sessions/' + id + '/tasks'
  const command = '/sessions/' + id + '/task-command'
  expect(await api.request(tasks)).toMatchObject({ cache: 'no-store', json: { items: [], current: { task: null } } })
  expect((await api.request(command, text('/task attach code 1', 4))).status).toBe(409)
  expect((await api.request(command, text('/task attach missing 1'))).status).toBe(404)
  expect((await api.request(tasks)).json.items).toHaveLength(0)
  const attach = text('/task attach code 1')
  const created = await api.request(command, attach)
  expect(created).toMatchObject({ status: 200, json: { ok: true, task: { workflowId: 'code', revision: 0 } } })
  const cancel = text('/task cancel')
  const cancelled = await api.request(command, cancel)
  expect(cancelled.json.task.status).toBe('cancelled')
  expect((await api.request(tasks)).json.current.task.id).toBe(created.json.task.id)
  await api.request(tasks, { operationId: 'second', task: 'Second', selection: 'none' })
  expect(await api.request(command, cancel)).toEqual(cancelled)
  expect(await api.request(command, attach)).toEqual(created)
  expect((await api.request(command, { ...attach, text: '/task pause' })).status).toBe(409)
  expect((await api.request(tasks)).json.current.task.task).toBe('Second')
  expect(api.db.prepare('SELECT COUNT(*) n FROM turns').get()).toEqual({ n: 0 })
})

it('fences commands from stale tabs even when the replacement task has the same revision', async () => {
  const session = createSessionRepository(api.db).createSession().id
  const url = '/sessions/' + session
  const empty = url + '/task-command?expectedTaskId=none'
  const attach = text('/task attach code 1')
  const first = await api.request(empty, attach)
  const old = url + '/task-command?expectedTaskId=' + first.json.task.id
  await api.request(old, text('/task cancel'))
  const second = await api.request(url + '/tasks', { operationId: 'second', task: 'Second', selection: 'none' })
  expect(second.json.task.revision).toBe(first.json.task.revision)
  const stale = text('/task pause')
  expect(await api.request(old, stale)).toMatchObject({ status: 409, json: { data: { error: { code: 'STALE_TASK_REVISION' } } } })
  expect((await api.request(url + '/task-command?expectedTaskId=' + second.json.task.id, stale)).status).toBe(409)
  expect((await api.request(empty, text('/task attach questionnaire 1'))).status).toBe(409)
  expect(await api.request(empty, attach)).toEqual(first)
  expect((await api.request(url + '/tasks')).json.current.task).toMatchObject({ id: second.json.task.id, status: 'active', workflowId: null })
})

it('requires a matching session and the exact approval, and returns the referenced artifact version', async () => {
  const a = fixture(api.db)
  const b = fixture(api.db)
  const [aid, bid] = await Promise.all([a.review(), b.review()])
  const path = '/tasks/' + a.id
  const q = '?sessionId=' + a.sessionId
  const revision = a.view().task!.revision
  const artifact = a.view().approvals[0]!.artifact
  expect(await api.request(path + q)).toMatchObject({ status: 200, cache: 'no-store', json: { approvals: [{ id: aid }] } })
  expect((await api.request(path + '?sessionId=' + b.sessionId)).status).toBe(404)
  expect((await api.request(path + '/artifacts/' + artifact.id + q)).json).toMatchObject({ id: artifact.id, hash: artifact.hash, content: 'First draft' })
  expect((await api.request(path + '/artifacts/' + b.view().approvals[0]!.artifact.id + q)).status).toBe(404)
  const actions = path + '/actions' + q
  expect((await api.request(actions, envelope({ type: 'approve', approvalId: bid }, revision))).status).toBe(404)
  for (const cmd of [{ type: 'finish' }, { type: 'approve', approvalId: aid, approved: true }, { type: 'validate', passed: true }])
    expect((await api.request(actions, envelope(cmd, revision))).status).toBe(400)
  expect((await api.request(actions, { ...envelope({ type: 'pause' }), actor: 'user' })).status).toBe(400)
  expect((await api.request(actions, envelope({ type: 'complete_basic' }, revision)))).toMatchObject({ status: 422, json: { data: { ok: false, task: { revision } } } })
  expect((await api.request('/sessions/' + a.sessionId + '/task-command', text('/task approve ' + aid, revision))).json.task.nodeId).toBe('build')
})

it('fences active turns and stale revisions, exposes only legal resume, and returns stable request IDs', async () => {
  const f = fixture(api.db, true)
  const turn = startTaskAwareTurn(api.db, { modelId: 'mock', agentConfig: {}, request: { sessionId: f.sessionId,
    requestId: crypto.randomUUID(), kind: 'message', message: { role: 'user', id: 'user', parts: [{ type: 'text', text: 'hello' }] } } })
  const uri = '/sessions/' + f.sessionId + '/task-command'
  expect((await api.request(uri, text('/task attach code 1'))).status).toBe(409)
  const paused = await api.request(uri, text('/task pause'))
  expect(paused.json.task.status).toBe('paused')
  expect((await api.request(uri, text('/task resume'))).status).toBe(409)
  api.db.prepare("UPDATE sessions SET status='running' WHERE id=?").run(f.sessionId)
  expect(f.view().actions).not.toContainEqual(expect.objectContaining({ type: 'resume' }))
  api.db.prepare("UPDATE sessions SET status='idle' WHERE id=?").run(f.sessionId)
  const req = text('/task resume', paused.json.task.revision)
  const resumed = await api.request(uri, req)
  expect(resumed.json.resumeRequestId).toBeTruthy()
  expect(await api.request(uri, req)).toEqual(resumed)
  expect(api.db.prepare('SELECT status FROM turns WHERE id=?').get(turn.turnId)).toEqual({ status: 'stopped' })
})
