import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createBranchRepository } from '../server/persistence/branch-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'
import { userProfileNameKey, validateUserProfileCreate, validateUserProfileUpdate } from '../shared/user-profile'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function createDb() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  return db
}

describe('user profile validation', () => {
  it('trims names while preserving instruction formatting and normalizing name keys', () => {
    expect(validateUserProfileCreate({ name: '  Обучение  ', instructions: 'Стиль:\n  кратко' })).toEqual({
      name: 'Обучение', instructions: 'Стиль:\n  кратко',
    })
    expect(userProfileNameKey('  ＦＯＯ  ')).toBe('foo')
  })

  it('accepts 16,000 UTF-16 units and rejects longer instructions', () => {
    expect(validateUserProfileCreate({ name: 'Длинный', instructions: 'я'.repeat(16_000) }).instructions).toHaveLength(16_000)
    expect(() => validateUserProfileCreate({ name: 'Длинный', instructions: 'я'.repeat(16_001) })).toThrow()
    expect(() => validateUserProfileCreate({ name: 'Astral', instructions: '😀'.repeat(8_001) })).toThrow()
  })

  it('rejects unknown fields, malformed Unicode, NUL, and empty names', () => {
    expect(() => validateUserProfileCreate({ name: 'ok', instructions: '', unexpected: true })).toThrow()
    expect(() => validateUserProfileCreate({ name: '\uD800', instructions: '' })).toThrow()
    expect(() => validateUserProfileCreate({ name: 'ok', instructions: '\u0000' })).toThrow()
    expect(() => validateUserProfileCreate({ name: '  ', instructions: '' })).toThrow()
    expect(() => validateUserProfileUpdate({ expectedRevision: 0 })).toThrow()
  })
})

describe('user profile repository', () => {
  it('creates unique profiles and rejects a normalized name collision without replacing the original', () => {
    const db = createDb()
    const profiles = createUserProfileRepository(db)
    const first = profiles.create({ name: 'Кратко', instructions: 'Ответь кратко' })

    expect(() => profiles.create({ name: ' КРАТКО ', instructions: 'другие правила' })).toThrow()
    expect(profiles.get(first.id)).toMatchObject({ name: 'Кратко', instructions: 'Ответь кратко', revision: 0 })
  })

  it('updates by expected revision and preserves fields not included in the patch', () => {
    const profiles = createUserProfileRepository(createDb())
    const created = profiles.create({ name: 'Учёба', instructions: 'Объясняй подробно' })

    expect(profiles.update(created.id, { name: 'Понятно', expectedRevision: 0 })).toMatchObject({
      name: 'Понятно', instructions: 'Объясняй подробно', revision: 1,
    })
    expect(() => profiles.update(created.id, { instructions: 'устаревшая запись', expectedRevision: 0 })).toThrow()
    expect(profiles.get(created.id)).toMatchObject({ name: 'Понятно', instructions: 'Объясняй подробно', revision: 1 })
  })

  it('deletes unused profiles and protects the default and assigned profiles', () => {
    const db = createDb()
    const profiles = createUserProfileRepository(db)
    const sessions = createSessionRepository(db)
    const removable = profiles.create({ name: 'Удаляемый', instructions: '' })

    expect(profiles.delete(removable.id)).toBe(true)
    expect(profiles.get(removable.id)).toBeUndefined()
    expect(profiles.delete(removable.id)).toBe(false)

    expect(() => profiles.delete(profiles.getDefaultId())).toThrowError(expect.objectContaining({ code: 'DEFAULT_PROFILE' }))

    const assigned = profiles.create({ name: 'Назначенный', instructions: '' })
    const session = sessions.createSession()
    profiles.selectForSession(session.id, assigned.id)
    expect(() => profiles.delete(assigned.id)).toThrowError(expect.objectContaining({ code: 'PROFILE_IN_USE' }))
  })

  it('uses a default for new sessions and only changes existing session selections explicitly', () => {
    const db = createDb()
    const profiles = createUserProfileRepository(db)
    const sessions = createSessionRepository(db)
    const originalDefault = profiles.getDefault()
    const first = sessions.createSession()
    const alternate = profiles.create({ name: 'Код', instructions: 'Примеры на TypeScript' })

    expect(profiles.getForSession(first.id)?.id).toBe(originalDefault.id)
    profiles.setDefault(alternate.id)
    const second = sessions.createSession()
    expect(profiles.getForSession(second.id)?.id).toBe(alternate.id)
    expect(profiles.getForSession(first.id)?.id).toBe(originalDefault.id)
    expect(profiles.selectForSession(first.id, alternate.id)).toMatchObject({ id: alternate.id, revision: 0 })
    expect(profiles.getForSession(first.id)?.id).toBe(alternate.id)
  })

  it('inherits the selected profile when branching a session', () => {
    const db = createDb()
    const profiles = createUserProfileRepository(db)
    const sessions = createSessionRepository(db)
    const parent = sessions.createSession()
    const selected = profiles.create({ name: 'Учёба', instructions: 'Поясняй шаг за шагом' })
    profiles.selectForSession(parent.id, selected.id)
    const now = new Date().toISOString()
    const answerId = randomUUID()
    db.prepare(`INSERT INTO messages (id, session_id, position, role, status, payload_json, storage_version, created_at, updated_at)
      VALUES (?, ?, 0, 'assistant', 'complete', ?, 1, ?, ?)`).run(
      answerId, parent.id, JSON.stringify({ id: answerId, role: 'assistant', parts: [{ type: 'text', text: 'Ответ' }] }), now, now,
    )

    const branch = createBranchRepository(db).createBranch({ parentSessionId: parent.id, throughMessageId: answerId })
    expect(profiles.getForSession(branch.id)?.id).toBe(selected.id)
  })

  it('requires a running-session selection to come from its own active turn', () => {
    const db = createDb()
    const profiles = createUserProfileRepository(db)
    const session = createSessionRepository(db).createSession()
    const target = profiles.create({ name: 'Альтернатива', instructions: '' })
    const initialProfile = profiles.getForSession(session.id)!
    const turnId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(`INSERT INTO turns (id, session_id, request_id, position, status, model_id, agent_config_json, started_at, updated_at)
      VALUES (?, ?, ?, 0, 'running', 'mock', '{}', ?, ?)`).run(turnId, session.id, turnId, timestamp, timestamp)

    expect(() => profiles.selectForSession(session.id, target.id)).toThrow()
    expect(profiles.selectForSession(session.id, target.id, { turnId })).toMatchObject({ id: target.id })
    expect(() => profiles.selectForSession(session.id, target.id, { turnId: randomUUID() })).toThrow()
    db.prepare("UPDATE turns SET status = 'stopped' WHERE id = ?").run(turnId)
    expect(() => profiles.selectForSession(session.id, initialProfile.id, { turnId })).toThrow()
  })

  it('returns the assigned snapshot and enforces the current active turn when supplied', () => {
    const db = createDb()
    const profiles = createUserProfileRepository(db)
    const session = createSessionRepository(db).createSession()
    const profile = profiles.create({ name: 'Код', instructions: 'Не обрезать' })
    profiles.selectForSession(session.id, profile.id)

    expect(profiles.getForTurn(session.id)).toMatchObject({
      id: profile.id, name: 'Код', revision: 0, instructions: 'Не обрезать',
    })
    expect(() => profiles.getForTurn(session.id, randomUUID())).toThrow()
  })
})
