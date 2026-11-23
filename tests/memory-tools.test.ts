import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createLongTermMemoryRepository } from '../server/memory/long-term-repository'
import { createSaveMemoryTool, createForgetMemoryTool } from '../server/tools/memory'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function invoke(tool: any, input: unknown) {
  if (!tool.execute) throw new Error('tool has no execute function')
  return tool.execute(input, { toolCallId: randomUUID(), messages: [], context: {} })
}

describe('memory tools', () => {
  it('describes mutable project facts as state and append-only notes separately', () => {
    const save = createSaveMemoryTool()

    expect(save.description).toContain('state for current mutable facts such as selected approaches, versions, and statuses')
    expect(save.description).toContain('note only for append-only observations or history')
  })

  it('upserts a saved fact and reports replacement metadata', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const save = createSaveMemoryTool({ db, sessionId: session.id, projectId: project.id })

    await expect(invoke(save, { layer: 'working', category: 'state', scope: 'current_project', key: 'status', value: 'draft' })).resolves.toMatchObject({ saved: true, status: 'created' })
    await expect(invoke(save, { layer: 'working', category: 'state', scope: 'current_project', key: 'STATUS', value: 'ready' })).resolves.toMatchObject({ saved: true, status: 'replaced', previousValue: 'draft' })
  })

  it('forgets all matching long-term facts in the requested scope', async () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const facts = createLongTermMemoryRepository(db)
    facts.create({ category: 'profile', key: 'status', value: 'draft', projectIds: [project.id] })
    const forget = createForgetMemoryTool({ db, sessionId: session.id, projectId: project.id })

    await expect(invoke(forget, { layer: 'long_term', scope: 'current_project', key: 'STATUS' })).resolves.toMatchObject({ forgotten: true, count: 1 })
    expect(facts.list({ projectId: project.id }).items).toEqual([])
  })
})
