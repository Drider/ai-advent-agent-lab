import { createApp, createRouter, toWebHandler } from 'h3'
import { beforeEach, afterEach, vi } from 'vitest'
import { openChatDatabase } from '../../server/persistence/db'
import { seedBuiltInWorkflows } from '../../server/workflows/templates'
import listTasks from '../../server/api/sessions/[id]/tasks/index.get'
import createTask from '../../server/api/sessions/[id]/tasks/index.post'
import command from '../../server/api/sessions/[id]/task-command.post'
import getTask from '../../server/api/tasks/[id].get'
import action from '../../server/api/tasks/[id]/actions.post'
import artifact from '../../server/api/tasks/[id]/artifacts/[artifactId].get'
import listWorkflows from '../../server/api/workflows/index.get'
import createWorkflow from '../../server/api/workflows/index.post'
import getWorkflow from '../../server/api/workflows/[id].get'
import publish from '../../server/api/workflows/[id]/versions.post'
import validate from '../../server/api/workflows/validate.post'
import setDefault from '../../server/api/user-profiles/[id]/workflow.patch'
import getSession from '../../server/api/sessions/[id].get'

const state = vi.hoisted(() => ({} as { db: ReturnType<typeof openChatDatabase> }))
vi.mock('../../server/persistence/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/persistence/db')>(), getChatDatabase: () => state.db,
}))

export function taskHttp() {
  beforeEach(() => { state.db = openChatDatabase(':memory:'); seedBuiltInWorkflows(state.db) })
  afterEach(() => state.db.close())
  const router = createRouter()
    .get('/sessions/:id', getSession)
    .get('/sessions/:id/tasks', listTasks).post('/sessions/:id/tasks', createTask)
    .post('/sessions/:id/task-command', command).get('/tasks/:id', getTask)
    .post('/tasks/:id/actions', action).get('/tasks/:id/artifacts/:artifactId', artifact)
    .get('/workflows', listWorkflows).post('/workflows', createWorkflow)
    .post('/workflows/validate', validate).get('/workflows/:id', getWorkflow)
    .post('/workflows/:id/versions', publish).patch('/user-profiles/:id/workflow', setDefault)
  const handle = toWebHandler(createApp().use(router.handler))
  return { get db() { return state.db }, async request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await handle(new Request('http://local.test' + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: response.status, json: await response.json(), cache: response.headers.get('cache-control') }
  } }
}
