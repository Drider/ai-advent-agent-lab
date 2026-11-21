import Database from 'better-sqlite3'
import { createApp, createRouter, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateChatDatabase } from '../server/persistence/migrations'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'

const databaseState = vi.hoisted((): { db: unknown } => ({ db: undefined }))

vi.mock('../server/persistence/db', () => ({ getChatDatabase: () => databaseState.db }))

import listProfiles from '../server/api/user-profiles/index.get'
import createProfile from '../server/api/user-profiles/index.post'
import getProfile from '../server/api/user-profiles/[id].get'
import updateProfile from '../server/api/user-profiles/[id].patch'
import deleteProfile from '../server/api/user-profiles/[id].delete'
import setDefaultProfile from '../server/api/user-profiles/default.patch'
import selectSessionProfile from '../server/api/sessions/[id]/user-profile.patch'
import getSession from '../server/api/sessions/[id].get'

let db: Database.Database
let request: (path: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateChatDatabase(db)
  databaseState.db = db

  const router = createRouter()
    .get('/user-profiles', listProfiles)
    .post('/user-profiles', createProfile)
    .get('/user-profiles/:id', getProfile)
    .patch('/user-profiles/:id', updateProfile)
    .delete('/user-profiles/:id', deleteProfile)
    .patch('/user-profiles/default', setDefaultProfile)
    .patch('/sessions/:id/user-profile', selectSessionProfile)
    .get('/sessions/:id', getSession)
  const handler = toWebHandler(createApp().use(router.handler))
  request = (path, init = {}) => handler(new Request(`http://local.test${path}`, init))
})

afterEach(() => db.close())

async function json(response: Response): Promise<any> {
  return response.json()
}

function body(method: string, payload: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
}

describe('user profile API', () => {
  it('lists summaries without instructions and reports the default with no-store headers', async () => {
    const created = await json(await request('/user-profiles', body('POST', { name: 'Код', instructions: 'Личный текст' })))
    const response = await request('/user-profiles')
    const result = await json(response)

    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(result).toMatchObject({ defaultProfileId: expect.any(String) })
    expect(result.items).toContainEqual(expect.objectContaining({ id: created.id, name: 'Код' }))
    expect(result.items.find((item: { id: string }) => item.id === created.id)).not.toHaveProperty('instructions')
  })

  it('creates, reads, updates by revision, and makes a new default without changing existing sessions', async () => {
    const originalSession = createSessionRepository(db).createSession()
    const created = await json(await request('/user-profiles', body('POST', { name: 'Учёба', instructions: 'Поясняй шаги' })))
    const detailResponse = await request(`/user-profiles/${created.id}`)
    expect(detailResponse.headers.get('cache-control')).toContain('no-store')
    expect(await json(detailResponse)).toMatchObject({ id: created.id, instructions: 'Поясняй шаги' })

    const updatedResponse = await request(`/user-profiles/${created.id}`, body('PATCH', {
      name: 'Для учёбы', expectedRevision: 0,
    }))
    expect(updatedResponse.status).toBe(200)
    expect(await json(updatedResponse)).toMatchObject({ name: 'Для учёбы', instructions: 'Поясняй шаги', revision: 1 })
    expect((await request(`/user-profiles/${created.id}`, body('PATCH', {
      instructions: 'устарело', expectedRevision: 0,
    }))).status).toBe(409)

    expect((await request('/user-profiles/default', body('PATCH', { profileId: created.id }))).status).toBe(200)
    const newSession = createSessionRepository(db).createSession()
    expect((await json(await request(`/sessions/${originalSession.id}`))).userProfileId).not.toBe(created.id)
    expect((await json(await request(`/sessions/${newSession.id}`))).userProfileId).toBe(created.id)
  })

  it('deletes an unused profile and rejects deleting the default or an assigned profile', async () => {
    const removable = await json(await request('/user-profiles', body('POST', { name: 'Удаляемый', instructions: '' })))
    const deletedResponse = await request(`/user-profiles/${removable.id}`, { method: 'DELETE' })

    expect(deletedResponse.status).toBe(200)
    expect(deletedResponse.headers.get('cache-control')).toContain('no-store')
    expect(await json(deletedResponse)).toEqual({ id: removable.id, deleted: true })
    expect((await request(`/user-profiles/${removable.id}`)).status).toBe(404)

    const defaultId = (await json(await request('/user-profiles'))).defaultProfileId
    expect((await request(`/user-profiles/${defaultId}`, { method: 'DELETE' })).status).toBe(409)

    const assigned = await json(await request('/user-profiles', body('POST', { name: 'Назначенный', instructions: '' })))
    const session = createSessionRepository(db).createSession()
    createUserProfileRepository(db).selectForSession(session.id, assigned.id)
    expect((await request(`/user-profiles/${assigned.id}`, { method: 'DELETE' })).status).toBe(409)
  })

  it('selects a profile for one idle session and rejects selection during an active turn', async () => {
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    const other = sessions.createSession()
    const created = await json(await request('/user-profiles', body('POST', { name: 'Кратко', instructions: 'Кратко' })))
    const selected = await request(`/sessions/${session.id}/user-profile`, body('PATCH', { profileId: created.id }))

    expect(selected.status).toBe(200)
    expect(await json(selected)).toMatchObject({ userProfileId: created.id, userProfile: { name: 'Кратко' } })
    expect((await json(await request(`/sessions/${other.id}`))).userProfileId).not.toBe(created.id)

    const turnId = crypto.randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`INSERT INTO turns (id, session_id, request_id, position, status, model_id, agent_config_json, started_at, updated_at)
      VALUES (?, ?, ?, 0, 'running', 'mock', '{}', ?, ?)`).run(turnId, session.id, turnId, timestamp, timestamp)
    expect((await request(`/sessions/${session.id}/user-profile`, body('PATCH', { profileId: created.id }))).status).toBe(409)
  })

  it('rejects malformed profiles and reports missing profiles or sessions', async () => {
    expect((await request('/user-profiles', body('POST', { name: 'bad', instructions: '', extra: true }))).status).toBe(400)
    const created = await json(await request('/user-profiles', body('POST', { name: 'Alpha', instructions: '' })))
    expect((await request('/user-profiles', body('POST', { name: ' alpha ', instructions: 'overwrite' }))).status).toBe(409)
    expect((await request('/user-profiles/missing')).status).toBe(404)
    expect((await request(`/user-profiles/${created.id}`, body('PATCH', { name: 'Beta', expectedRevision: 4 }))).status).toBe(409)
    expect((await request('/sessions/missing/user-profile', body('PATCH', { profileId: created.id }))).status).toBe(404)
  })
})
