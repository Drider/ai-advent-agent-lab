import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMPACTION_SETTINGS, DEFAULT_CONTEXT_STRATEGY_SETTINGS } from '../shared/chat'
import { getAgentConfig } from '../server/agent/chat-agent'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'
import { startMemoryAwareTurn } from '../server/memory/start-turn'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function createTurnRequest(sessionId: string) {
  return {
    kind: 'message' as const,
    sessionId,
    requestId: randomUUID(),
    message: { id: randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'Помоги с планом' }] },
  }
}

describe('user profile turn snapshots', () => {
  it('uses one immutable profile snapshot for a turn and reads edits on the following turn', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const profiles = createUserProfileRepository(db)
    const session = createSessionRepository(db).createSession()
    const profile = profiles.create({ name: 'Кратко', instructions: 'Отвечай двумя предложениями' })
    profiles.selectForSession(session.id, profile.id)
    const createAgentConfig = (snapshot: { id: string; name: string; revision: number; instructions: string }) =>
      getAgentConfig(DEFAULT_COMPACTION_SETTINGS, DEFAULT_CONTEXT_STRATEGY_SETTINGS, snapshot)

    const first = startMemoryAwareTurn(db, {
      request: createTurnRequest(session.id),
      modelId: 'mock-model',
      agentConfig: {},
      createAgentConfig,
    })
    const stored = db.prepare('SELECT agent_config_json FROM turns WHERE id = ?').get(first.turnId) as { agent_config_json: string }
    const savedConfig = JSON.parse(stored.agent_config_json) as Record<string, any>
    expect(first.profileSnapshot).toMatchObject({ id: profile.id, revision: 0, instructions: 'Отвечай двумя предложениями' })
    expect(first.agentConfig.instructions).toContain('Отвечай двумя предложениями')
    expect(savedConfig.profile).toEqual({ id: profile.id, revision: 0 })
    expect(savedConfig.instructionsHash).toBe(first.agentConfig.instructionsHash)
    expect(JSON.stringify(first.snapshot.messages)).not.toContain('Отвечай двумя предложениями')

    profiles.update(profile.id, { instructions: 'Показывай список шагов', expectedRevision: 0 })
    expect(first.profileSnapshot.instructions).toBe('Отвечай двумя предложениями')
    expect(JSON.parse(stored.agent_config_json).instructions).toContain('Отвечай двумя предложениями')

    createTurnRepository(db).finishTurn({
      turnId: first.turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Готово' }] },
      status: 'completed',
    })
    const second = startMemoryAwareTurn(db, {
      request: createTurnRequest(session.id),
      modelId: 'mock-model',
      agentConfig: {},
      createAgentConfig,
    })
    expect(second.profileSnapshot).toMatchObject({ id: profile.id, revision: 1, instructions: 'Показывай список шагов' })
    expect(second.agentConfig.instructions).toContain('Показывай список шагов')
  })

  it('rejects a profile-expanded prompt that exceeds the immediate window before saving the user message', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const profiles = createUserProfileRepository(db)
    const session = createSessionRepository(db).createSession()
    const profile = profiles.create({ name: 'Много инструкций', instructions: 'x'.repeat(16_000) })
    profiles.selectForSession(session.id, profile.id)
    const createAgentConfig = (snapshot: { id: string; name: string; revision: number; instructions: string }) =>
      getAgentConfig({ enabled: false, messageThreshold: 20, contextWindowTokens: 10_000 }, DEFAULT_CONTEXT_STRATEGY_SETTINGS, snapshot)

    expect(() => startMemoryAwareTurn(db, {
      request: createTurnRequest(session.id),
      modelId: 'mock-model',
      agentConfig: {},
      createAgentConfig,
    })).toThrow(/context window budget exceeded/u)
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'user'").get()).toEqual({ count: 0 })
  })
})
