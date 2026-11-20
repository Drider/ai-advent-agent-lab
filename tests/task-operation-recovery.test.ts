import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createArtifactStore } from '../server/tasks/artifacts'
import { createTaskToolOperations } from '../server/tasks/tool-operations'
import { recoverTaskOperations } from '../server/tasks/recovery'
import { taskToolFixture } from './helpers/task-tools'

describe('task operation receipts', () => {
  it.each([true, false])('replays the action with a new call ID and rejects conflicting input (basic=%s)', async basic => {
    const f = taskToolFixture(basic)
    try {
      const first = await f.write('first')()
      expect(first).toMatchObject({ ok: true })
      expect(await f.write('replayed')()).toEqual(first)
      await expect(f.write('changed', 'other')()).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
      expect(f.db.prepare('SELECT count(*) AS n FROM task_tool_operations').get()).toEqual({ n: 1 })
      if (!basic) expect(createArtifactStore(f.db).receipts(f.id, f.actor.stepNodeVisitId!, ['first', 'replayed']))
        .toHaveLength(2)
    } finally { f.close() }
  })

  it('rolls back both intents when the tool execution row cannot be inserted', async () => {
    const f = taskToolFixture()
    try {
      f.db.exec("CREATE TRIGGER broken BEFORE INSERT ON tool_executions BEGIN SELECT RAISE(ABORT, 'intent failed'); END")
      await expect(f.write()()).rejects.toThrow('intent failed')
      expect(f.exists()).toBe(false)
      expect(f.db.prepare('SELECT id FROM task_tool_operations').all()).toEqual([])
    } finally { f.close() }
  })

  it('recovers a write after receipt failure by inspecting exact file bytes without retrying', async () => {
    const f = taskToolFixture()
    try {
      f.db.exec("CREATE TRIGGER broken BEFORE UPDATE ON tool_executions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END")
      await expect(f.write('first', '\uFEFFdata\u0000')()).rejects.toThrow('receipt failed')
      expect(f.exists()).toBe(true)
      expect(f.view().recoveryOperations).toMatchObject([{ status: 'uncertain' }])
      f.db.exec('DROP TRIGGER broken')
      await expect(f.write('again', '\uFEFFdata\u0000')()).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' })
      f.turns.markStopped(f.actor.turnId)
      expect(f.turns.assessContinuation(f.actor.turnId)).toBe('needs_review')
      const op = f.view().recoveryOperations[0]!
      expect(op).toMatchObject({ status: 'uncertain', path: 'out.txt' })
      await f.ok({ type: 'cancel' }, 'user')
      expect(f.service.create({ sessionId: f.sessionId, task: 'New', operationId: 'next' }, f.user))
        .toMatchObject({ ok: false, error: { code: 'RECOVERY_REVIEW_REQUIRED' } })
      const ops = createTaskToolOperations(f.db, { rootDir: f.rootDir })
      await expect(ops.resolve(op.id, f.actor)).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' })
      await ops.resolve(op.id, f.user)
      expect(f.view().recoveryOperations).toEqual([])
      expect(f.turns.assessContinuation(f.actor.turnId)).toBe('safe')
      expect(createArtifactStore(f.db).receipts(f.id, f.actor.stepNodeVisitId!, ['first'])).toHaveLength(1)
      expect(f.service.create({ sessionId: f.sessionId, task: 'New', operationId: 'next2' }, f.user)).toMatchObject({ ok: true })
    } finally { f.close() }
  })

  it('requires user review of mismatched contents and never overwrites the file', async () => {
    const f = taskToolFixture()
    try {
      const ops = createTaskToolOperations(f.db, { rootDir: f.rootDir })
      const op = ops.reserve({ taskId: f.id, toolName: 'write_file', nodeVisitId: f.actor.stepNodeVisitId,
        actionKey: 'report', input: { path: 'out.txt', content: 'expected' }, turnId: f.actor.turnId, toolCallId: 'write' })
      writeFileSync(join(f.rootDir, 'out.txt'), 'different')
      f.turns.recoverRunningTurns()
      recoverTaskOperations(f.db)
      await expect(ops.resolve(op.id, f.user)).rejects.toMatchObject({ code: 'RECOVERY_REVIEW_REQUIRED' })
      expect(f.view().recoveryOperations[0]?.observedHash).toHaveLength(64)
      expect(readFileSync(join(f.rootDir, 'out.txt'), 'utf8')).toBe('different')
      await f.ok({ type: 'resolve_recovery', operationId: op.id, outcome: 'failed' }, 'user')
      expect(f.view().recoveryOperations).toEqual([])
      expect(createArtifactStore(f.db).receipts(f.id, f.actor.stepNodeVisitId!, ['write'])).toEqual([])
    } finally { f.close() }
  })
})

it('closes a restarted read-only checker receipt without blocking safe continuation', () => {
  const f = taskToolFixture()
  try {
    f.turns.recordToolStart({ turnId: f.actor.turnId, toolCallId: 'check', taskId: f.id,
      name: 'run_task_checks', stepIndex: 0, input: { operationId: 'checking' } })
    f.turns.recoverRunningTurns()
    recoverTaskOperations(f.db)
    expect(f.turns.assessContinuation(f.actor.turnId)).toBe('safe')
    expect(f.db.prepare("SELECT status FROM tool_executions WHERE tool_call_id = 'check'").get()).toEqual({ status: 'failed' })
  } finally { f.close() }
})

it('preserves an earlier source receipt when a later turn replays its action', async () => {
  const f = taskToolFixture()
  try {
    const output = await f.write('original')()
    f.turns.markStopped(f.actor.turnId)
    const { turnId } = f.turns.beginUserTurn({ requestId: 'second-turn', sessionId: f.sessionId, modelId: 'test',
      message: { id: 'second-message', role: 'user', parts: [] }, agentConfig: {} })
    f.db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(f.id, turnId)
    const ops = createTaskToolOperations(f.db)
    const reserve = (toolCallId: string) => ops.reserve({ taskId: f.id, toolName: 'write_file', turnId, toolCallId,
      nodeVisitId: f.actor.stepNodeVisitId, actionKey: 'report-v1', input: { content: 'ok', path: 'out.txt' } })
    expect(() => reserve('original')).toThrowError(expect.objectContaining({ code: 'OPERATION_CONFLICT' }))
    expect(reserve('second-call')).toMatchObject({ kind: 'replay', output })
    const receipts = createArtifactStore(f.db).receipts(f.id, f.actor.stepNodeVisitId!, ['original', 'second-call'])
    expect(receipts.map(row => row.toolCallId)).toEqual(['original', 'second-call'])
  } finally { f.close() }
})
