import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { createChatAgent } from '../server/agent/chat-agent'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'
import { createUserProfileTools } from '../server/tools/user-profiles'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function database() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  return db
}

function invoke(tool: any, input: unknown = {}) {
  if (!tool.execute) throw new Error('tool has no execute function')
  return tool.execute(input, { toolCallId: randomUUID(), messages: [], context: {} })
}

function reserveTurn(db: ReturnType<typeof database>, sessionId: string) {
  const requestId = randomUUID()
  return createTurnRepository(db).beginUserTurn({
    sessionId,
    requestId,
    modelId: 'mock-model',
    message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Поменяй профиль' }] },
    agentConfig: {},
  }).turnId
}

describe('user profile tools', () => {
  it('lists current and default IDs, and returns the assigned full profile by default', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const profiles = createUserProfileRepository(db)
    const selected = profiles.create({ name: 'Учёба', instructions: 'Пиши как преподаватель' })
    profiles.selectForSession(session.id, selected.id)
    const tools = createUserProfileTools({ db, sessionId: session.id, turnId: reserveTurn(db, session.id) })

    await expect(invoke(tools.list_user_profiles)).resolves.toMatchObject({
      currentProfileId: selected.id,
      defaultProfileId: profiles.getDefaultId(),
      profiles: expect.arrayContaining([expect.objectContaining({ id: selected.id, name: 'Учёба', revision: 0 })]),
    })
    await expect(invoke(tools.get_user_profile)).resolves.toMatchObject({ ok: true, profile: { id: selected.id, instructions: 'Пиши как преподаватель' } })
  })

  it('creates profiles only with an explicit request and updates only supplied fields at the expected revision', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const tools = createUserProfileTools({ db, sessionId: session.id, turnId: reserveTurn(db, session.id) })
    const created = await invoke(tools.create_user_profile, { name: 'Коротко', instructions: 'Сначала вывод' }) as any
    expect(created).toMatchObject({ created: true, chatAssignmentChanged: false, defaultChanged: false, profile: { name: 'Коротко', instructions: 'Сначала вывод', revision: 0 } })

    const updated = await invoke(tools.update_user_profile, {
      id: created.profile.id,
      expectedRevision: 0,
      instructions: 'Сначала вывод, затем детали',
    }) as any
    expect(updated).toMatchObject({ updated: true, appliesFromNextTurn: true, profile: { name: 'Коротко', instructions: 'Сначала вывод, затем детали', revision: 1 } })

    await expect(invoke(tools.update_user_profile, {
      id: created.profile.id,
      expectedRevision: 0,
      name: 'Потерянное обновление',
    })).resolves.toMatchObject({ updated: false, error: { code: 'REVISION_CONFLICT' } })
    expect(createUserProfileRepository(db).get(created.profile.id)?.name).toBe('Коротко')
  })

  it('binds selection to the server session and permits only its active turn', async () => {
    const db = database()
    const sessions = createSessionRepository(db)
    const first = sessions.createSession()
    const second = sessions.createSession()
    const profiles = createUserProfileRepository(db)
    const target = profiles.create({ name: 'Для чата', instructions: 'Отвечай по-русски' })
    const turnId = reserveTurn(db, first.id)
    const tools = createUserProfileTools({ db, sessionId: first.id, turnId })

    const result = await invoke(tools.select_user_profile, { id: target.id, sessionId: second.id })
    expect(result).toMatchObject({ selected: true, appliesFromNextTurn: true, profile: { id: target.id } })
    expect(profiles.getForSession(first.id)?.id).toBe(target.id)
    expect(profiles.getForSession(second.id)?.id).not.toBe(target.id)
  })

  it('rejects selection when the server-bound turn has already stopped', async () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const profiles = createUserProfileRepository(db)
    const target = profiles.create({ name: 'Остановленный ход', instructions: '' })
    const turnId = reserveTurn(db, session.id)
    createTurnRepository(db).markFailed(turnId)
    const tools = createUserProfileTools({ db, sessionId: session.id, turnId })

    await expect(invoke(tools.select_user_profile, { id: target.id })).resolves.toMatchObject({
      selected: false,
      error: { code: 'TURN_NOT_ACTIVE' },
    })
    expect(profiles.getForSession(session.id)?.id).not.toBe(target.id)
  })

  it('limits safe continuation requests to read-only profile tools', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: 'text', text: 'Продолжаю.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      },
    })
    const agent = createChatAgent(model, undefined, { disableMutatingTools: true })
    await agent.generate({ prompt: 'Продолжи ответ' })
    const toolNames = model.doGenerateCalls[0]?.tools?.map(tool => tool.name) ?? []
    expect(toolNames).toEqual(expect.arrayContaining(['list_user_profiles', 'get_user_profile']))
    expect(toolNames).not.toEqual(expect.arrayContaining(['create_user_profile', 'update_user_profile', 'select_user_profile']))
  })
})
