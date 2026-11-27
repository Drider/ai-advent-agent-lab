import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { INITIAL_USER_PROFILE_ID } from '../server/persistence/migrations'
import { createSchedulerRepository } from '../server/scheduler/repository'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('scheduler database migration', () => {
  it('upgrades the old report delivery table without losing delivered messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-migration-'))
    directories.push(directory)
    const path = join(directory, 'chat.sqlite')
    const db = openChatDatabase(path)
    const repository = createSchedulerRepository(db)
    const sessionId = '00000000-0000-4000-8000-000000000002'
    const messageId = '00000000-0000-4000-8000-000000000003'
    const deliveredAt = '2026-11-27T21:50:00.000Z'
    db.prepare('INSERT INTO sessions (id, run_log_id, title, created_at, updated_at, user_profile_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'scheduler-migration', 'Test chat', deliveredAt, deliveredAt, INITIAL_USER_PROFILE_ID)
    const job = repository.createJob({
      name: 'Clock', sourceId: 'clock', sourceQuery: {}, collectCron: '*/2 * * * *', reportCron: '*/10 * * * *', timezone: 'Europe/Moscow', summaryInstruction: 'summarize',
      nextCollectAt: deliveredAt, nextReportAt: deliveredAt,
    })
    const report = repository.claimReport(job.id, deliveredAt, '2026-11-27T21:40:00.000Z', deliveredAt)!
    db.prepare(`INSERT INTO messages (id, session_id, position, role, status, payload_json, created_at, updated_at)
      VALUES (?, ?, 0, 'assistant', 'complete', '{}', ?, ?)`).run(messageId, sessionId, deliveredAt, deliveredAt)
    db.exec(`DROP TABLE scheduled_report_deliveries;
      CREATE TABLE scheduled_report_deliveries (
        report_id TEXT PRIMARY KEY REFERENCES scheduled_reports(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        delivered_at TEXT NOT NULL
      );`)
    db.prepare('INSERT INTO scheduled_report_deliveries (report_id, session_id, message_id, delivered_at) VALUES (?, ?, ?, ?)')
      .run(report.id, sessionId, messageId, deliveredAt)
    db.pragma('user_version = 21')
    db.close()

    const upgraded = openChatDatabase(path)
    const upgradedRepository = createSchedulerRepository(upgraded)
    expect(upgradedRepository.deliverPendingReports()).toBe(0)
    expect(upgraded.prepare('SELECT session_id, message_id, status, created_at, delivered_at FROM scheduled_report_deliveries WHERE report_id = ?').get(report.id))
      .toEqual({ session_id: sessionId, message_id: messageId, status: 'delivered', created_at: deliveredAt, delivered_at: deliveredAt })
    const pendingReport = upgradedRepository.claimReport(job.id, '2026-11-27T22:00:00.000Z', deliveredAt, '2026-11-27T22:00:00.000Z')!
    upgraded.prepare(`INSERT INTO scheduled_report_deliveries (report_id, session_id, status, created_at)
      VALUES (?, ?, 'pending', ?)`).run(pendingReport.id, sessionId, deliveredAt)
    expect(upgradedRepository.deliverPendingReports()).toBe(0)
    upgraded.close()
  })
})
