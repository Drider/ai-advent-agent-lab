import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { MemoryError } from '../server/memory/errors'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function createDatabase() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  return db
}

describe('projects', () => {
  it('groups sessions and filters them without changing the unfiltered list', () => {
    const db = createDatabase()
    const projects = createProjectRepository(db)
    const sessions = createSessionRepository(db)
    const alpha = projects.create('Alpha')
    const beta = projects.create('Beta')
    const inAlpha = sessions.createSession({ projectId: alpha.id })
    const inBeta = sessions.createSession({ projectId: beta.id })
    const unassigned = sessions.createSession()

    expect(sessions.listSessions({ projectId: alpha.id }).items.map(item => item.id)).toEqual([inAlpha.id])
    expect(sessions.listSessions({ projectId: null }).items.map(item => item.id)).toEqual([unassigned.id])
    expect(sessions.listSessions().items.map(item => item.id)).toEqual(expect.arrayContaining([inAlpha.id, inBeta.id, unassigned.id]))
  })

  it('assigns an old session once and protects project revisions', () => {
    const db = createDatabase()
    const projects = createProjectRepository(db)
    const sessions = createSessionRepository(db)
    const alpha = projects.create('Alpha')
    const beta = projects.create('Beta')
    const session = sessions.createSession()

    projects.assignSession(session.id, alpha.id)
    expect(sessions.listSessions({ projectId: alpha.id }).items[0]?.projectId).toBe(alpha.id)
    expect(() => projects.assignSession(session.id, beta.id)).toThrow(MemoryError)
    expect(() => projects.rename(alpha.id, 'Alpha 2', 99)).toThrow(MemoryError)
    expect(projects.rename(alpha.id, 'Alpha 2', 0).revision).toBe(1)
  })

  it('rejects unknown projects and invalid names', () => {
    const db = createDatabase()
    const projects = createProjectRepository(db)
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()

    expect(() => projects.create('   ')).toThrow(MemoryError)
    expect(() => projects.assignSession(session.id, 'missing-project')).toThrow(MemoryError)
    expect(() => projects.rename('missing-project', 'Name', 0)).toThrow(MemoryError)
  })

  it('blocks assignment while a session is running or being cleared', () => {
    const db = createDatabase()
    const projects = createProjectRepository(db)
    const sessions = createSessionRepository(db)
    const project = projects.create('Alpha')
    const running = sessions.createSession()
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(running.id)
    expect(() => projects.assignSession(running.id, project.id)).toThrow(MemoryError)

    const pending = sessions.createSession()
    db.prepare(`
      INSERT INTO history_clear_operations
        (id, session_id, old_run_log_id, new_run_log_id, status, started_at)
      VALUES ('clear-1', ?, ?, ?, 'pending_files', datetime('now'))
    `).run(pending.id, pending.runLogId, 'new-run')
    expect(() => projects.assignSession(pending.id, project.id)).toThrow(MemoryError)
  })
})
