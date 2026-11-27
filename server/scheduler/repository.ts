import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CHAT_MESSAGE_STORAGE_VERSION, type ChatUIMessage } from '../../shared/chat'
import type { PeriodReport, ScheduledJob, ScheduledJobInput, ScheduledRun, SchedulerReportStatus, SchedulerRunStatus } from '../../shared/scheduler'

interface JobRow {
  id: string; name: string; source_id: string; source_query_json: string; collect_cron: string; report_cron: string; timezone: string; summary_instruction: string; model_id: string | null; session_id: string | null; status: 'active' | 'paused'; next_collect_at: string; next_report_at: string; created_at: string; updated_at: string
}
interface RunRow { id: string; job_id: string; scheduled_for: string; status: SchedulerRunStatus; observed_at: string | null; error: string | null; started_at: string; finished_at: string | null }
interface ReportRow { id: string; job_id: string; scheduled_for: string; period_from: string; period_to: string; status: SchedulerReportStatus; run_count: number; success_count: number; failure_count: number; missed_count: number; result_count: number; text: string | null; text_status: PeriodReport['textStatus']; error: string | null; created_at: string; finished_at: string | null }
interface ReportResultRow { run_id: string; scheduled_for: string; observed_at: string; status: SchedulerRunStatus; error: string | null; payload_json: string }

function parseJob(row: JobRow): ScheduledJob {
  return { id: row.id, name: row.name, sourceId: row.source_id, sourceQuery: JSON.parse(row.source_query_json) as Record<string, string>, collectCron: row.collect_cron, reportCron: row.report_cron, timezone: row.timezone, summaryInstruction: row.summary_instruction, ...(row.model_id === null ? {} : { modelId: row.model_id }), ...(row.session_id === null ? {} : { sessionId: row.session_id }), status: row.status, nextCollectAt: row.next_collect_at, nextReportAt: row.next_report_at, createdAt: row.created_at, updatedAt: row.updated_at }
}

function formatReportTime(value: string, timezone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date)
  } catch {
    return value
  }
}

function formatReportMessage(job: Pick<ScheduledJob, 'id' | 'name' | 'timezone'>, report: PeriodReport): string {
  const lines = [
    `## 📊 Отчёт: «${job.name}»`,
    `Период: ${formatReportTime(report.from, job.timezone)} — ${formatReportTime(report.to, job.timezone)} (конечная граница не включается)`,
    `ID задания: ${job.id}`,
    '',
    `Запусков: ${report.runCount}`,
    `Успешно: ${report.successCount}`,
    `С ошибкой: ${report.failureCount}`,
    `Пропущено: ${report.missedCount}`,
    `Результатов: ${report.resultCount}`,
  ]
  if (report.status === 'failed') {
    lines.push('', `Не удалось сформировать сводку: ${report.error ?? 'неизвестная ошибка'}`)
  } else {
    lines.push('', '### Сводка', report.text?.trim() || 'За период сохранённых результатов нет.')
  }
  return lines.join('\n')
}

function parseRun(row: RunRow): ScheduledRun {
  return { id: row.id, jobId: row.job_id, scheduledFor: row.scheduled_for, status: row.status, ...(row.observed_at === null ? {} : { observedAt: row.observed_at }), ...(row.error === null ? {} : { error: row.error }), startedAt: row.started_at, ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }) }
}

function parseReport(row: ReportRow): PeriodReport {
  return { id: row.id, jobId: row.job_id, scheduledFor: row.scheduled_for, from: row.period_from, to: row.period_to, status: row.status, runCount: row.run_count, successCount: row.success_count, failureCount: row.failure_count, missedCount: row.missed_count, resultCount: row.result_count, ...(row.text === null ? {} : { text: row.text }), textStatus: row.text_status, ...(row.error === null ? {} : { error: row.error }), createdAt: row.created_at, ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }) }
}

export function createSchedulerRepository(db: Database.Database) {
  const transaction = <T>(callback: () => T): T => db.transaction(callback).immediate()

  function getJob(id: string): ScheduledJob | undefined {
    const row = db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? parseJob(row) : undefined
  }

  function createJob(input: ScheduledJobInput & { nextCollectAt: string; nextReportAt: string; sessionId?: string }): ScheduledJob {
    const timestamp = new Date().toISOString()
    const id = randomUUID()
    db.prepare(`INSERT INTO scheduled_jobs
      (id, name, source_id, source_query_json, collect_cron, report_cron, timezone, summary_instruction, model_id, session_id, status, next_collect_at, next_report_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, input.name, input.sourceId, JSON.stringify(input.sourceQuery), input.collectCron, input.reportCron, input.timezone, input.summaryInstruction, input.modelId ?? null, input.sessionId ?? null, input.nextCollectAt, input.nextReportAt, timestamp, timestamp)
    return getJob(id)!
  }

  function listJobs(): ScheduledJob[] {
    return (db.prepare('SELECT * FROM scheduled_jobs ORDER BY updated_at DESC, id DESC').all() as JobRow[]).map(parseJob)
  }

  function deleteJob(id: string): 'deleted' | 'busy' | 'not_found' {
    return transaction(() => {
      const job = db.prepare('SELECT 1 FROM scheduled_jobs WHERE id = ?').get(id)
      if (!job) return 'not_found'

      const activeWork = db.prepare(`SELECT 1 FROM scheduled_runs WHERE job_id = ? AND status = 'running'
        UNION ALL
        SELECT 1 FROM scheduled_reports WHERE job_id = ? AND status = 'running'
        LIMIT 1`).get(id, id)
      if (activeWork) return 'busy'

      db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(id)
      return 'deleted'
    })
  }

  function setStatus(id: string, status: 'active' | 'paused'): ScheduledJob {
    const result = db.prepare('UPDATE scheduled_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id)
    if (result.changes !== 1) throw new Error('scheduled job not found')
    return getJob(id)!
  }

  function updateNextCollect(id: string, nextCollectAt: string): void {
    db.prepare('UPDATE scheduled_jobs SET next_collect_at = ?, updated_at = ? WHERE id = ?').run(nextCollectAt, new Date().toISOString(), id)
  }

  function updateNextReport(id: string, nextReportAt: string): void {
    db.prepare('UPDATE scheduled_jobs SET next_report_at = ?, updated_at = ? WHERE id = ?').run(nextReportAt, new Date().toISOString(), id)
  }

  function claimRun(jobId: string, scheduledFor: string, now = new Date()): ScheduledRun | null {
    return transaction(() => {
      if (!db.prepare('SELECT 1 FROM scheduled_jobs WHERE id = ?').get(jobId)) return null
      const id = randomUUID()
      const timestamp = now.toISOString()
      try {
        db.prepare(`INSERT INTO scheduled_runs (id, job_id, scheduled_for, status, started_at)
          VALUES (?, ?, ?, 'running', ?)`).run(id, jobId, scheduledFor, timestamp)
      } catch (error) {
        if (String(error).includes('UNIQUE')) return null
        throw error
      }
      return parseRun(db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id) as RunRow)
    })
  }

  function finishRun(id: string, result: { status: Exclude<SchedulerRunStatus, 'running'>; observedAt?: string; error?: string }, finishedAt = new Date()): ScheduledRun {
    const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id) as RunRow | undefined
    if (!row) throw new Error('scheduled run not found')
    db.prepare(`UPDATE scheduled_runs SET status = ?, observed_at = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(result.status, result.observedAt ?? null, result.error ?? null, finishedAt.toISOString(), id)
    return parseRun(db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id) as RunRow)
  }

  function markMissed(id: string, error = 'scheduled run was missed', at = new Date()): ScheduledRun {
    return finishRun(id, { status: 'missed', error }, at)
  }

  function listRuns(jobId: string, limit = 100): ScheduledRun[] {
    return (db.prepare('SELECT * FROM scheduled_runs WHERE job_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?').all(jobId, Math.max(1, Math.min(500, limit))) as RunRow[]).map(parseRun)
  }

  function claimReport(jobId: string, scheduledFor: string, periodFrom: string, periodTo: string, now = new Date()): PeriodReport | null {
    return transaction(() => {
      if (!db.prepare('SELECT 1 FROM scheduled_jobs WHERE id = ?').get(jobId)) return null
      const id = randomUUID()
      try {
        db.prepare(`INSERT INTO scheduled_reports (id, job_id, scheduled_for, period_from, period_to, status, text_status, created_at)
          VALUES (?, ?, ?, ?, ?, 'running', 'pending', ?)`).run(id, jobId, scheduledFor, periodFrom, periodTo, now.toISOString())
      } catch (error) {
        if (String(error).includes('UNIQUE')) {
          const existing = db.prepare('SELECT * FROM scheduled_reports WHERE job_id = ? AND scheduled_for = ?').get(jobId, scheduledFor) as ReportRow | undefined
          if (!existing || existing.status === 'completed') return null
          db.prepare(`UPDATE scheduled_reports SET status = 'running', text_status = 'pending', error = NULL, finished_at = NULL WHERE id = ?`).run(existing.id)
          return parseReport(db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(existing.id) as ReportRow)
        }
        throw error
      }
      return parseReport(db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(id) as ReportRow)
    })
  }

  function clearReportMembers(reportId: string): void {
    db.prepare('DELETE FROM scheduled_report_results WHERE report_id = ?').run(reportId)
  }

  function addReportMembers(reportId: string, runIds: string[]): void {
    const insert = db.prepare('INSERT OR IGNORE INTO scheduled_report_results (report_id, run_id) VALUES (?, ?)')
    transaction(() => { for (const runId of runIds) insert.run(reportId, runId) })
  }

  function deliverPendingReports(limit = 50): number {
    const pending = db.prepare(`SELECT report_id FROM scheduled_report_deliveries
      WHERE status = 'pending' ORDER BY created_at ASC, report_id ASC LIMIT ?`)
      .all(Math.max(1, Math.min(200, limit))) as Array<{ report_id: string }>
    let delivered = 0

    for (const { report_id: reportId } of pending) {
      try {
        const didDeliver = transaction(() => {
          const delivery = db.prepare(`SELECT session_id FROM scheduled_report_deliveries
            WHERE report_id = ? AND status = 'pending'`).get(reportId) as { session_id: string } | undefined
          if (!delivery) return false
          const clearPending = db.prepare(`SELECT 1 FROM history_clear_operations
            WHERE session_id = ? AND status <> 'completed' LIMIT 1`).get(delivery.session_id)
          if (clearPending) return false
          if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(delivery.session_id)) return false

          const reportRow = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(reportId) as ReportRow | undefined
          if (!reportRow || reportRow.status === 'running') return false
          const report = parseReport(reportRow)
          const job = db.prepare('SELECT id, name, timezone FROM scheduled_jobs WHERE id = ?').get(report.jobId) as Pick<JobRow, 'id' | 'name' | 'timezone'> | undefined
          if (!job) return false

          const timestamp = new Date().toISOString()
          const messageId = randomUUID()
          const message: ChatUIMessage = {
            id: messageId,
            role: 'assistant',
            parts: [{ type: 'text', text: formatReportMessage(job, report) }],
          }
          const position = (db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS next_position FROM messages WHERE session_id = ?').get(delivery.session_id) as { next_position: number }).next_position
          db.prepare(`INSERT INTO messages
            (id, session_id, turn_id, position, role, status, payload_json, storage_version, created_at, updated_at)
            VALUES (?, ?, NULL, ?, 'assistant', 'complete', ?, ?, ?, ?)`).run(messageId, delivery.session_id, position, JSON.stringify(message), CHAT_MESSAGE_STORAGE_VERSION, timestamp, timestamp)
          db.prepare(`UPDATE scheduled_report_deliveries
            SET status = 'delivered', message_id = ?, delivered_at = ?
            WHERE report_id = ? AND status = 'pending'`).run(messageId, timestamp, reportId)
          db.prepare('UPDATE sessions SET updated_at = ?, revision = revision + 1 WHERE id = ?').run(timestamp, delivery.session_id)
          return true
        })
        if (didDeliver) delivered += 1
      } catch (error) {
        console.error('[scheduler] could not deliver report to its chat', error)
      }
    }

    return delivered
  }

  function finishReport(id: string, input: { status: SchedulerReportStatus; runCount: number; successCount: number; failureCount: number; missedCount: number; resultCount: number; text?: string; textStatus: PeriodReport['textStatus']; error?: string }, at = new Date()): PeriodReport {
    const report = transaction(() => {
      const timestamp = at.toISOString()
      db.prepare(`UPDATE scheduled_reports SET status = ?, run_count = ?, success_count = ?, failure_count = ?, missed_count = ?, result_count = ?, text = ?, text_status = ?, error = ?, finished_at = ? WHERE id = ?`)
        .run(input.status, input.runCount, input.successCount, input.failureCount, input.missedCount, input.resultCount, input.text ?? null, input.textStatus, input.error ?? null, timestamp, id)
      const reportRow = db.prepare('SELECT * FROM scheduled_reports WHERE id = ?').get(id) as ReportRow | undefined
      if (!reportRow) throw new Error('scheduled report not found')
      const report = parseReport(reportRow)
      const job = db.prepare('SELECT session_id FROM scheduled_jobs WHERE id = ?').get(report.jobId) as Pick<JobRow, 'session_id'> | undefined

      if (report.status !== 'running' && job?.session_id && !db.prepare('SELECT 1 FROM scheduled_report_deliveries WHERE report_id = ?').get(id)) {
        const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(job.session_id)
        if (sessionExists) {
          db.prepare(`INSERT INTO scheduled_report_deliveries
            (report_id, session_id, status, created_at)
            VALUES (?, ?, 'pending', ?)`).run(id, job.session_id, timestamp)
        }
      }

      return report
    })
    if (report.status !== 'running') deliverPendingReports()
    return report
  }

  function listReports(jobId: string, limit = 50): PeriodReport[] {
    return (db.prepare('SELECT * FROM scheduled_reports WHERE job_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?').all(jobId, Math.max(1, Math.min(200, limit))) as ReportRow[]).map(parseReport)
  }

  function listReportRunIds(reportId: string): string[] {
    return (db.prepare('SELECT run_id FROM scheduled_report_results WHERE report_id = ? ORDER BY run_id').all(reportId) as Array<{ run_id: string }>).map(row => row.run_id)
  }

  function listReportResults(reportId: string, limit = 50): Array<{ runId: string; scheduledFor: string; observedAt: string; status: SchedulerRunStatus; error?: string; payload: unknown }> {
    const rows = db.prepare(`SELECT r.id AS run_id, r.scheduled_for, sr.observed_at, r.status, r.error, sr.payload_json
      FROM scheduled_report_results rr
      JOIN scheduled_runs r ON r.id = rr.run_id
      JOIN scheduled_results sr ON sr.run_id = rr.run_id
      WHERE rr.report_id = ?
      ORDER BY r.scheduled_for DESC, r.id DESC
      LIMIT ?`).all(reportId, Math.max(1, Math.min(100, limit))) as ReportResultRow[]
    return rows.reverse().map(row => ({ runId: row.run_id, scheduledFor: row.scheduled_for, observedAt: row.observed_at, status: row.status, ...(row.error === null ? {} : { error: row.error }), payload: JSON.parse(row.payload_json) as unknown }))
  }

  function counts(jobId: string, from: string, to: string): Pick<PeriodReport, 'runCount' | 'successCount' | 'failureCount' | 'missedCount'> {
    const row = db.prepare(`SELECT COUNT(*) AS run_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count,
      SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed_count
      FROM scheduled_runs WHERE job_id = ? AND scheduled_for >= ? AND scheduled_for < ?`).get(jobId, from, to) as { run_count: number; success_count: number | null; failure_count: number | null; missed_count: number | null }
    return { runCount: row.run_count, successCount: row.success_count ?? 0, failureCount: row.failure_count ?? 0, missedCount: row.missed_count ?? 0 }
  }

  function acquireLease(ownerId: string, now = new Date(), ttlMs = 30_000): boolean {
    return transaction(() => {
      const current = db.prepare('SELECT owner_id, expires_at FROM scheduler_lease WHERE id = 1').get() as { owner_id: string; expires_at: string } | undefined
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
      if (current && current.owner_id !== ownerId && Date.parse(current.expires_at) > now.getTime()) return false
      db.prepare(`INSERT INTO scheduler_lease (id, owner_id, acquired_at, renewed_at, expires_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, renewed_at = excluded.renewed_at, expires_at = excluded.expires_at`).run(ownerId, now.toISOString(), now.toISOString(), expiresAt)
      return true
    })
  }

  function renewLease(ownerId: string, now = new Date(), ttlMs = 30_000): boolean {
    const result = db.prepare('UPDATE scheduler_lease SET renewed_at = ?, expires_at = ? WHERE id = 1 AND owner_id = ?').run(now.toISOString(), new Date(now.getTime() + ttlMs).toISOString(), ownerId)
    return result.changes === 1
  }

  function releaseLease(ownerId: string): void {
    db.prepare('DELETE FROM scheduler_lease WHERE id = 1 AND owner_id = ?').run(ownerId)
  }

  function recoverRunningRuns(now = new Date(), staleMs = 60_000): void {
    const cutoff = new Date(now.getTime() - staleMs).toISOString()
    const rows = db.prepare(`SELECT id FROM scheduled_runs WHERE status = 'running' AND started_at < ?`).all(cutoff) as Array<{ id: string }>
    for (const row of rows) {
      const hasResult = db.prepare('SELECT 1 FROM scheduled_results WHERE run_id = ?').get(row.id)
      finishRun(row.id, hasResult ? { status: 'completed' } : { status: 'failed', error: 'worker restarted while run was in progress' }, now)
    }
  }

  function getResultPayload(runId: string): unknown | undefined {
    const row = db.prepare('SELECT payload_json FROM scheduled_results WHERE run_id = ?').get(runId) as { payload_json: string } | undefined
    return row ? JSON.parse(row.payload_json) as unknown : undefined
  }

  function saveResult(runId: string, payload: unknown, observedAt: string, now = new Date()): { saved: boolean; runId: string } {
    const run = db.prepare('SELECT job_id, scheduled_for, status FROM scheduled_runs WHERE id = ?').get(runId) as { job_id: string; scheduled_for: string; status: SchedulerRunStatus } | undefined
    if (!run) throw new Error('scheduled run not found')
    if (run.status !== 'running' && !db.prepare('SELECT 1 FROM scheduled_results WHERE run_id = ?').get(runId)) throw new Error('scheduled run is not active')
    const payloadJson = JSON.stringify(payload)
    if (payloadJson === undefined) throw new Error('payload must be JSON serializable')
    const inserted = db.prepare(`INSERT OR IGNORE INTO scheduled_results (run_id, job_id, scheduled_for, observed_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(runId, run.job_id, run.scheduled_for, observedAt, payloadJson, now.toISOString())
    return { saved: inserted.changes === 1, runId }
  }

  function readResults(jobId: string, from: string, to: string, cursor?: { scheduledFor: string; runId: string }, limit = 100): Array<{ runId: string; scheduledFor: string; observedAt: string; payload: unknown }> {
    const pageSize = Math.max(1, Math.min(100, limit))
    const rows = cursor
      ? db.prepare(`SELECT run_id, scheduled_for, observed_at, payload_json FROM scheduled_results
          WHERE job_id = ? AND scheduled_for >= ? AND scheduled_for < ?
            AND (scheduled_for > ? OR (scheduled_for = ? AND run_id > ?))
          ORDER BY scheduled_for ASC, run_id ASC LIMIT ?`).all(jobId, from, to, cursor.scheduledFor, cursor.scheduledFor, cursor.runId, pageSize)
      : db.prepare(`SELECT run_id, scheduled_for, observed_at, payload_json FROM scheduled_results
          WHERE job_id = ? AND scheduled_for >= ? AND scheduled_for < ?
          ORDER BY scheduled_for ASC, run_id ASC LIMIT ?`).all(jobId, from, to, pageSize)
    return (rows as Array<{ run_id: string; scheduled_for: string; observed_at: string; payload_json: string }>).map(row => ({ runId: row.run_id, scheduledFor: row.scheduled_for, observedAt: row.observed_at, payload: JSON.parse(row.payload_json) as unknown }))
  }

  function reportMembers(reportId: string): string[] { return listReportRunIds(reportId) }

  return { getJob, createJob, listJobs, deleteJob, pauseJob: (id: string) => setStatus(id, 'paused'), resumeJob: (id: string) => setStatus(id, 'active'), updateNextCollect, updateNextReport, claimRun, finishRun, markMissed, listRuns, claimReport, clearReportMembers, addReportMembers, finishReport, deliverPendingReports, listReports, listReportRunIds, listReportResults, reportMembers, counts, acquireLease, renewLease, releaseLease, recoverRunningRuns, getResultPayload, saveResult, readResults }
}
