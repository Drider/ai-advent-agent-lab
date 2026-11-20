import { tool } from 'ai'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { taskToolFixture } from './helpers/task-tools'
import { assertTaskToolAllowed } from '../server/tasks/tool-policy'
import { material } from './task-workflow-fixture'

describe('execute-time task policy', () => {
  it('rejects a write prepared before pause and stops the running turn', async () => {
    const f = taskToolFixture()
    try {
      const invoke = f.write()
      await f.ok({ type: 'pause' }, 'user')
      await expect(invoke()).rejects.toMatchObject({ code: 'TASK_PAUSED' })
      expect(f.exists()).toBe(false)
      expect(f.turns.getLastTurn(f.sessionId)?.status).toBe('stopped')
    } finally { f.close() }
  })

  it('requires a fresh step after a transition in the same batch', async () => {
    const f = taskToolFixture()
    try {
      await f.ok(material('context', 'Ready'))
      const invoke = f.write()
      const moved = f.service.apply(f.id, { command: { type: 'transition', transitionId: 'needs_context' },
        operationId: 'advance', expectedRevision: f.view().task!.revision }, f.actor, { toolCallId: 'move' })
      const write = invoke()
      expect(await moved).toMatchObject({ ok: true })
      await expect(write).rejects.toMatchObject({ code: 'TRANSITION_NOT_ALLOWED' })
      expect(f.exists()).toBe(false)
    } finally { f.close() }
  })

  it('permits a read across a progress revision while checking registry, ownership and node permissions', async () => {
    const f = taskToolFixture()
    try {
      await f.ok({ type: 'update_progress', progress: 'Still in this visit' })
      const check = (toolName: string, actor = f.actor) => assertTaskToolAllowed(f.db, { taskId: f.id, toolName, actor })
      expect(() => check('read_file')).not.toThrow()
      for (const name of ['rollDie', 'future_tool', 'constructor']) expect(() => check(name)).toThrow()
      expect(() => check('read_file', { ...f.actor, sessionId: 'other' })).toThrow()
      expect(() => check('read_file', { ...f.actor, turnId: 'other' })).toThrow()
    } finally { f.close() }
  })

  it('rejects a mutation if the bound turn is a safe continuation', async () => {
    const f = taskToolFixture(true)
    try {
      f.turns.markStopped(f.actor.turnId)
      const { turnId } = f.turns.beginContinuation({ sessionId: f.sessionId, requestId: 'continue',
        sourceTurnId: f.actor.turnId, modelId: 'test', agentConfig: {}, message: { id: 'm2', role: 'user', parts: [] } })
      f.db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(f.id, turnId)
      const actor = { ...f.actor, turnId }
      expect(() => assertTaskToolAllowed(f.db, { taskId: f.id, toolName: 'read_file', actor })).not.toThrow()
      expect(() => assertTaskToolAllowed(f.db, { taskId: f.id, toolName: 'write_file', actor })).toThrow()
    } finally { f.close() }
  })
})

it('records a progress update while a read is running in the same visit', async () => {
  const f = taskToolFixture()
  try {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const wrapped = f.wrap(tool({ inputSchema: z.object({ path: z.string() }), execute: async () => {
      await pending
      return { ok: true, data: { path: 'input', text: '42' } }
    } }), 'read_file')
    const result = wrapped.execute!({ path: 'input' }, { toolCallId: 'read', messages: [], context: {} })
    try {
      await f.ok({ type: 'update_progress', progress: 'Checking input' })
    } finally {
      finish()
      await result
    }
    expect(f.db.prepare('SELECT status FROM task_tool_operations').get()).toEqual({ status: 'completed' })
  } finally { f.close() }
})

it('aborts the registered stream only after the pause and stopped turn commit', async () => {
  const f = taskToolFixture()
  try {
    const controller = new AbortController()
    f.turns.attachStream(f.actor.turnId, controller)
    let observed: unknown
    controller.signal.addEventListener('abort', () => {
      observed = [f.db.inTransaction, f.view().task?.status, f.turns.getLastTurn(f.sessionId)?.status]
    })
    f.db.exec("CREATE TRIGGER broken BEFORE INSERT ON task_events WHEN NEW.type = 'paused' BEGIN SELECT RAISE(ABORT, 'pause failed'); END")
    await expect(f.ok({ type: 'pause' }, 'user')).rejects.toThrow('pause failed')
    expect(controller.signal.aborted).toBe(false)
    expect(f.turns.getLastTurn(f.sessionId)?.status).toBe('running')
    f.db.exec('DROP TRIGGER broken')
    await f.ok({ type: 'pause' }, 'user')
    expect(observed).toEqual([false, 'paused', 'stopped'])
  } finally { f.close() }
})
