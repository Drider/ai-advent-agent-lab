import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createMemorySettingsRepository } from '../server/memory/settings-repository'
import { startMemoryAwareTurn } from '../server/memory/start-turn'
import { MemoryError } from '../server/memory/errors'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const request = (sessionId: string) => ({
  kind: 'message' as const,
  sessionId,
  requestId: randomUUID(),
  message: { id: randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'continue' }] },
})

describe('memory-aware turn start', () => {
  it('does not create a turn when a memory layer exceeds its budget', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    createWorkingMemoryRepository(db).create({ projectId: project.id, category: 'note', key: 'large', value: 'x'.repeat(10_000) })
    createMemorySettingsRepository(db).update({ workingTokens: 100, expectedRevision: 0 })

    expect(() => startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })).toThrow(MemoryError)
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({ count: 0 })
  })

  it('starts a turn with a fresh snapshot after memory changes', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const working = createWorkingMemoryRepository(db)
    working.create({ projectId: project.id, category: 'state', key: 'status', value: 'ready' })

    const started = startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })
    expect(started.turnId).toBeTruthy()
    expect(started.snapshot.workingEntries[0]?.value).toBe('ready')
    expect(db.prepare('SELECT status FROM turns WHERE id = ?').get(started.turnId)).toEqual({ status: 'running' })
  })
})
