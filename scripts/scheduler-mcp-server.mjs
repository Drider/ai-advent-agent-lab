import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const dbPath = process.env.SCHEDULER_DB_PATH ?? join(process.cwd(), 'data', 'chat.sqlite')
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 1000')

function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
}

function parseSources() {
  const raw = process.env.SCHEDULER_SOURCES_JSON || JSON.stringify([{ id: 'clock', kind: 'clock', allowedQueryKeys: [] }])
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('SCHEDULER_SOURCES_JSON must be an array')
  return new Map(parsed.map(source => [source.id, source]))
}

function encodeCursor(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url') }
function decodeCursor(value) {
  if (!value) return undefined
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new Error('cursor is invalid') }
}

function ensureTables() {
  // Normal application startup creates these in the main migration. This small
  // guard also makes the standalone MCP process useful in integration tests.
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scheduled_for TEXT NOT NULL, status TEXT NOT NULL, observed_at TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, UNIQUE(job_id, scheduled_for));
    CREATE TABLE IF NOT EXISTS scheduled_results (run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scheduled_for TEXT NOT NULL, observed_at TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS scheduled_results_job_time_idx ON scheduled_results(job_id, scheduled_for, run_id);`)
}
ensureTables()

const server = new McpServer({ name: 'scheduled-jobs-mcp', version: '1.0.0' })

server.registerTool('get_data', {
  title: 'Get scheduled source data',
  description: 'Fetch data from a configured scheduler source. The source URL is selected by the server configuration.',
  inputSchema: {
    sourceId: z.string().min(1),
    query: z.record(z.string(), z.string()).optional(),
  },
}, async ({ sourceId, query = {} }) => {
  try {
    const source = parseSources().get(sourceId)
    if (!source) throw new Error(`unknown scheduler source: ${sourceId}`)
    for (const key of Object.keys(query)) if (!source.allowedQueryKeys?.includes(key)) throw new Error(`source query key is not allowed: ${key}`)
    if (source.kind === 'clock') return { content: [{ type: 'text', text: JSON.stringify({ sourceId, observedAt: new Date().toISOString(), payload: { now: new Date().toISOString() } }) }] }
    const url = new URL(source.url)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw new Error('source URL must use HTTPS')
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`source returned HTTP ${response.status}`)
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new Error('source response exceeds 256 KiB')
    let payload
    try { payload = JSON.parse(body) } catch { throw new Error('source response is not valid JSON') }
    return { content: [{ type: 'text', text: JSON.stringify({ sourceId, observedAt: new Date().toISOString(), payload }) }] }
  } catch (error) { return errorResult(error) }
})

server.registerTool('save_result', {
  title: 'Save scheduled result',
  description: 'Persist one scheduler run result. Repeating the same runId is idempotent.',
  inputSchema: {
    runId: z.string().uuid(),
    payload: z.unknown(),
    observedAt: z.string().datetime({ offset: true }),
  },
}, async ({ runId, payload, observedAt }) => {
  try {
    const run = db.prepare('SELECT job_id, scheduled_for, status FROM scheduled_runs WHERE id = ?').get(runId)
    if (!run) throw new Error('scheduled run not found')
    if (run.status !== 'running' && !db.prepare('SELECT 1 FROM scheduled_results WHERE run_id = ?').get(runId)) throw new Error('scheduled run is not active')
    const payloadJson = JSON.stringify(payload)
    if (payloadJson === undefined) throw new Error('payload must be JSON serializable')
    const inserted = db.prepare(`INSERT OR IGNORE INTO scheduled_results (run_id, job_id, scheduled_for, observed_at, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(runId, run.job_id, run.scheduled_for, observedAt, payloadJson, new Date().toISOString())
    return { content: [{ type: 'text', text: JSON.stringify({ saved: inserted.changes === 1, runId }) }] }
  } catch (error) { return errorResult(error) }
})

server.registerTool('read_period', {
  title: 'Read scheduled period',
  description: 'Read every saved result in a half-open UTC period, using stable pagination.',
  inputSchema: {
    jobId: z.string().uuid(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(100),
  },
}, async ({ jobId, from, to, cursor, limit = 100 }) => {
  try {
    if (Date.parse(from) >= Date.parse(to)) throw new Error('period must have from before to')
    const decoded = decodeCursor(cursor)
    const rows = decoded
      ? db.prepare(`SELECT run_id, scheduled_for, observed_at, payload_json FROM scheduled_results
          WHERE job_id = ? AND scheduled_for >= ? AND scheduled_for < ?
          AND (scheduled_for > ? OR (scheduled_for = ? AND run_id > ?))
          ORDER BY scheduled_for ASC, run_id ASC LIMIT ?`).all(jobId, from, to, decoded.scheduledFor, decoded.scheduledFor, decoded.runId, limit + 1)
      : db.prepare(`SELECT run_id, scheduled_for, observed_at, payload_json FROM scheduled_results
          WHERE job_id = ? AND scheduled_for >= ? AND scheduled_for < ?
          ORDER BY scheduled_for ASC, run_id ASC LIMIT ?`).all(jobId, from, to, limit + 1)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(row => ({ runId: row.run_id, scheduledFor: row.scheduled_for, observedAt: row.observed_at, payload: JSON.parse(row.payload_json) }))
    const last = items.at(-1)
    const nextCursor = hasMore && last ? encodeCursor({ scheduledFor: last.scheduledFor, runId: last.runId }) : undefined
    return { content: [{ type: 'text', text: JSON.stringify({ items, ...(nextCursor ? { nextCursor } : {}) }) }] }
  } catch (error) { return errorResult(error) }
})

const transport = new StdioServerTransport()
server.connect(transport).catch(error => { console.error(error); process.exitCode = 1 })

process.on('exit', () => { try { db.close() } catch {} })
