import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatUIMessage } from '../shared/chat'
import { openChatDatabase } from '../server/persistence/db'
import { createBranchRepository } from '../server/persistence/branch-repository'
import { createSessionRepository } from '../server/persistence/session-repository'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function saveMessage(db: ReturnType<typeof openChatDatabase>, sessionId: string, position: number, message: ChatUIMessage): void {
  const timestamp = new Date().toISOString()
  db.prepare(`
    INSERT INTO messages
      (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, 'complete', ?, 1, ?, ?)
  `).run(message.id, sessionId, position, message.role, JSON.stringify(message), timestamp, timestamp)
}

describe('dialogue branches', () => {
  it('copies a completed prefix into two independent child sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-branches-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const sessions = createSessionRepository(db)
    const parent = sessions.createSession()
    const user: ChatUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Начало' }] }
    const answer: ChatUIMessage = { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Ответ' }] }
    saveMessage(db, parent.id, 0, user)
    saveMessage(db, parent.id, 1, answer)

    const branches = createBranchRepository(db)
    const first = branches.createBranch({ parentSessionId: parent.id, throughMessageId: answer.id })
    const second = branches.createBranch({ parentSessionId: parent.id, throughMessageId: answer.id })
    expect(first.id).not.toBe(second.id)
    expect(first.parentSessionId).toBe(parent.id)
    expect((await sessions.getSession(first.id))?.messages).toHaveLength(2)
    expect((await sessions.getSession(first.id))?.messages.map(message => message.id)).not.toEqual([user.id, answer.id])
    expect((await sessions.getSession(second.id))?.messages).toHaveLength(2)
    expect(() => branches.createBranch({ parentSessionId: parent.id, throughMessageId: user.id })).toThrow()
    db.close()
  })

  it('carries strategy state and valid memory forward without coupling the parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-branches-state-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const sessions = createSessionRepository(db)
    const parent = sessions.createSession()
    sessions.setContextStrategySettings(parent.id, { strategy: 'sticky_facts', windowSize: 6, messageThreshold: 20 })
    const user: ChatUIMessage = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Владелец — Ирина' }] }
    const answer: ChatUIMessage = { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Зафиксировал.' }] }
    saveMessage(db, parent.id, 0, user)
    saveMessage(db, parent.id, 1, answer)
    db.prepare(`
      INSERT INTO facts_updates
        (id, session_id, source_message_id, through_message_position, facts_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'completed', ?)
    `).run(randomUUID(), parent.id, user.id, 0, JSON.stringify({ owner: 'Ирина' }), new Date().toISOString())

    const child = createBranchRepository(db).createBranch({ parentSessionId: parent.id, throughMessageId: answer.id })
    const childDetail = await sessions.getSession(child.id)
    expect(childDetail?.contextStrategy).toEqual({ strategy: 'sticky_facts', windowSize: 6, messageThreshold: 20 })
    expect(childDetail?.stickyFacts).toEqual({ owner: 'Ирина' })

    sessions.setContextStrategySettings(child.id, { strategy: 'off', windowSize: 2, messageThreshold: 20 })
    expect((await sessions.getSession(parent.id))?.contextStrategy.strategy).toBe('sticky_facts')

    sessions.deleteSession(parent.id)
    expect((await sessions.getSession(child.id))?.parent).toBeUndefined()
    expect(sessions.listSessions().items.find(item => item.id === child.id)?.branchSourceMessageId).toBe(answer.id)
    db.close()
  })

  it('rejects a parent with a running turn before creating a child', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-branches-running-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const sessions = createSessionRepository(db)
    const parent = sessions.createSession()
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(parent.id)
    const answer: ChatUIMessage = { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Ответ' }] }
    saveMessage(db, parent.id, 1, answer)
    expect(() => createBranchRepository(db).createBranch({ parentSessionId: parent.id, throughMessageId: answer.id })).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 })
    db.close()
  })

  it('inherits the parent project without copying project memory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-chat-branches-project-'))
    directories.push(directory)
    const db = openChatDatabase(join(directory, 'chat.sqlite'))
    const sessions = createSessionRepository(db)
    const projectId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare('INSERT INTO projects (id, name, revision, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(projectId, 'Project', timestamp, timestamp)
    const parent = sessions.createSession({ projectId })
    const answer: ChatUIMessage = { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Ответ' }] }
    saveMessage(db, parent.id, 1, answer)

    const child = createBranchRepository(db).createBranch({ parentSessionId: parent.id, throughMessageId: answer.id })
    expect(child.projectId).toBe(projectId)
    expect((await sessions.getSession(child.id))?.projectId).toBe(projectId)
    expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(child.id)).toEqual({ project_id: projectId })
    db.close()
  })
})
