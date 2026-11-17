import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createHistoryClearService } from '../server/memory/clear-service'
import { MemoryError } from '../server/memory/errors'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe('dialogue history clearing', () => {
  it('removes only short-term history and preserves project and independent memory', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const turns = createTurnRepository(db)
    const message = { id: randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'source' }] }
    const started = turns.beginUserTurn({ sessionId: session.id, requestId: randomUUID(), modelId: 'mock', message, agentConfig: {} })
    turns.finishTurn({ turnId: started.turnId, message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }, status: 'completed' })
    const working = createWorkingMemoryRepository(db).create({ projectId: project.id, category: 'state', key: 'status', value: 'kept', sourceSessionId: session.id, sourceMessageId: message.id })
    const fact = createLongTermMemoryRepository(db).create({ category: 'knowledge', key: 'fact', value: 'kept', projectIds: [project.id], sourceSessionId: session.id, sourceMessageId: message.id })
    const service = createHistoryClearService(db, { deleteLog: async () => undefined })

    const result = await service.clear(session.id, randomUUID())
    expect(result.status).toBe('completed')
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns WHERE session_id = ?').get(session.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT project_id, title FROM sessions WHERE id = ?').get(session.id)).toMatchObject({ project_id: project.id, title: 'Новый диалог' })
    expect(createWorkingMemoryRepository(db).list(project.id).items).toEqual([expect.objectContaining({ id: working.id, value: 'kept', sourceSessionId: session.id })])
    expect(createWorkingMemoryRepository(db).list(project.id).items[0]?.sourceMessageId).toBeUndefined()
    expect(createLongTermMemoryRepository(db).list({ projectId: project.id }).items).toEqual([expect.objectContaining({ id: fact.id, value: 'kept', sourceSessionId: session.id })])
    expect(createLongTermMemoryRepository(db).list({ projectId: project.id }).items[0]?.sourceMessageId).toBeUndefined()
    expect(() => turns.beginUserTurn({ sessionId: session.id, requestId: started.turnId, modelId: 'mock', message, agentConfig: {} })).toThrow('TURN_ALREADY_EXISTS')
  })

  it('blocks new operations while file cleanup is pending and can retry the same operation', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    let fail = true
    const service = createHistoryClearService(db, { deleteLog: async () => { if (fail) throw new Error('disk unavailable') } })
    const operationId = randomUUID()
    const pending = await service.clear(session.id, operationId)
    expect(pending.status).toBe('failed')
    expect(() => createTurnRepository(db).beginUserTurn({ sessionId: session.id, requestId: randomUUID(), modelId: 'mock', message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'blocked' }] }, agentConfig: {} })).toThrow(MemoryError)
    fail = false
    expect((await service.clear(session.id, operationId)).status).toBe('completed')
    expect((await service.clear(session.id, operationId)).status).toBe('completed')
  })
})
