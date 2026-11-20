import { createModelConfigurationRepository } from '../server/persistence/model-configuration-repository'
import { createModelConfigurationTools } from '../server/tools/model-configurations'
import { createUserProfileTools } from '../server/tools/user-profiles/user-profile-tools'
import { taskToolFixture } from './helpers/task-tools'
import { tool, type Tool } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { recordToolExecution } from '../server/agent/recorded-tools'
import { z } from 'zod'

type Repository = Parameters<typeof recordToolExecution>[1]['repository']

function createTool(execute: (input: { value: string }, options: { toolCallId: string }) => Promise<string>): Tool {
  return tool({
    inputSchema: z.object({ value: z.string() }),
    execute,
  })
}

function executionOptions(toolCallId: string) {
  return { toolCallId, messages: [], context: {} }
}

describe('recordToolExecution', () => {
  it('commits intent before execution and output after execution', async () => {
    const events: string[] = []
    const repository: Repository = {
      recordToolStart: async () => { events.push('intent-committed') },
      recordToolEnd: async () => { events.push('result-committed') },
    }
    const wrapped = recordToolExecution(createTool(async (input) => {
      events.push('tool-executed')
      return input.value.toUpperCase()
    }), { turnId: 'turn-1', getStepIndex: () => 2, repository, toolName: 'mutating' })

    await expect(wrapped.execute?.({ value: 'ok' }, executionOptions('call-1'))).resolves.toBe('OK')
    expect(events).toEqual(['intent-committed', 'tool-executed', 'result-committed'])
  })

  it('does not execute a side effect when intent persistence fails', async () => {
    const executeSpy = vi.fn(async () => 'never')
    const wrapped = recordToolExecution(createTool(executeSpy), {
      turnId: 'turn-1',
      getStepIndex: () => 0,
      repository: {
        recordToolStart: async () => { throw new Error('intent failed') },
        recordToolEnd: async () => undefined,
      },
    })

    await expect(wrapped.execute?.({ value: 'x' }, executionOptions('call-1'))).rejects.toThrow('intent failed')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('does not execute a side effect when the turn was stopped before the intent commit', async () => {
    const executeSpy = vi.fn(async () => 'never')
    const wrapped = recordToolExecution(createTool(executeSpy), {
      turnId: 'turn-1',
      getStepIndex: () => 0,
      repository: {
        recordToolStart: async () => false,
        recordToolEnd: async () => undefined,
      },
    })

    await expect(wrapped.execute?.({ value: 'x' }, executionOptions('call-1')))
      .rejects.toThrow('turn is no longer running')
    expect(executeSpy).not.toHaveBeenCalled()
  })

  it('surfaces a result persistence failure without retrying the tool', async () => {
    const executeSpy = vi.fn(async () => 'side effect happened')
    const wrapped = recordToolExecution(createTool(executeSpy), {
      turnId: 'turn-1',
      getStepIndex: () => 0,
      repository: {
        recordToolStart: async () => undefined,
        recordToolEnd: async () => { throw new Error('result failed') },
      },
    })

    await expect(wrapped.execute?.({ value: 'x' }, executionOptions('call-1'))).rejects.toThrow('result failed')
    expect(executeSpy).toHaveBeenCalledOnce()
  })

  it('uses the same current step index for parallel tool calls', async () => {
    const stepIndexes: number[] = []
    const wrapped = recordToolExecution(createTool(async () => 'ok'), {
      turnId: 'turn-1',
      getStepIndex: () => 7,
      repository: {
        recordToolStart: async ({ stepIndex }) => { stepIndexes.push(stepIndex) },
        recordToolEnd: async () => undefined,
      },
    })

    await Promise.all([
      wrapped.execute?.({ value: 'a' }, executionOptions('call-1')),
      wrapped.execute?.({ value: 'b' }, executionOptions('call-2')),
    ])
    expect(stepIndexes).toEqual([7, 7])
  })
})

it('keeps the actual result when an in-flight write finishes after cancellation', async () => {
  const f = taskToolFixture()
  try {
    let finish!: () => void
    const effect = new Promise<void>(resolve => { finish = resolve })
    const result = { ok: true, data: { path: 'out.txt', bytesWritten: 2 } }
    const wrapped = f.wrap(tool({ inputSchema: z.object({ content: z.string(), path: z.string() }),
      execute: async (input) => {
        expect(f.db.inTransaction).toBe(false)
        expect(input).toEqual({ path: 'out.txt', content: 'ok' })
        await effect
        return result
      } }), 'write_file')
    const pending = wrapped.execute!({ actionKey: 'report', path: 'out.txt', content: 'ok' }, executionOptions('late'))
    await f.ok({ type: 'cancel' }, 'user')
    finish()
    await expect(pending).resolves.toEqual(result)
    expect(f.view().task?.status).toBe('cancelled')
    expect(f.db.prepare("SELECT status FROM task_tool_operations WHERE action_key = 'report'").get()).toEqual({ status: 'completed' })
  } finally { f.close() }
})

it('rolls back a SQLite task mutation, event and command if its tool receipt fails', async () => {
  const f = taskToolFixture()
  try {
    const envelope = { operationId: 'note', expectedRevision: 0, command: { type: 'update_progress' as const, progress: 'Working' } }
    f.db.exec("CREATE TRIGGER broken BEFORE UPDATE ON tool_executions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END")
    await expect(f.service.apply(f.id, envelope, f.actor, { toolCallId: 'note-call' })).rejects.toThrow('receipt failed')
    expect(f.view().task?.revision).toBe(0)
    expect(f.db.prepare("SELECT operation_id FROM task_commands WHERE operation_id = 'note'").get()).toBeUndefined()
    f.db.exec('DROP TRIGGER broken')
    expect(await f.service.apply(f.id, envelope, f.actor, { toolCallId: 'retry' })).toMatchObject({ ok: true })
    expect(f.db.prepare("SELECT status FROM tool_executions WHERE tool_call_id = 'retry'").get()).toEqual({ status: 'completed' })
  } finally { f.close() }
})

it('atomically creates a SQLite profile and its operation receipt', async () => {
  const f = taskToolFixture(true)
  try {
    f.db.exec("CREATE TRIGGER broken BEFORE UPDATE ON tool_executions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END")
    const source = createUserProfileTools({ db: f.db, sessionId: f.sessionId, turnId: f.actor.turnId })
    const wrapped = f.wrap(source.create_user_profile, 'create_user_profile')
    const input = { actionKey: 'profile', name: 'Atomic profile', instructions: 'Read carefully' }
    await expect(wrapped.execute!(input, executionOptions('profile-call'))).rejects.toThrow('receipt failed')
    expect(f.db.prepare("SELECT id FROM user_profiles WHERE name = 'Atomic profile'").get()).toBeUndefined()
    f.db.exec('DROP TRIGGER broken')
    await expect(wrapped.execute!(input, executionOptions('retry'))).resolves.toMatchObject({ created: true })
  } finally { f.close() }
})

it('requires a bounded ASCII action key in both model schema and direct execution', async () => {
  const f = taskToolFixture(true)
  try {
    const wrapped = f.wrap(tool({ inputSchema: z.object({ path: z.string() }).strict(), execute: () => ({ ok: true }) }), 'write_file')
    const schema = wrapped.inputSchema as z.ZodObject
    expect(schema.safeParse({ path: 'out' }).success).toBe(false)
    expect(schema.safeParse({ path: 'out', actionKey: 'write-1' }).success).toBe(true)
    for (const actionKey of ['', 'bad key', 'a'.repeat(81)]) {
      await expect(wrapped.execute!({ path: 'out', actionKey }, executionOptions('bad'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
  } finally { f.close() }
})

it('can retry a rolled-back SQLite deletion with the previously listed configuration', async () => {
  const f = taskToolFixture(true)
  try {
    const { id } = createModelConfigurationRepository(f.db).save({ name: 'Config', modelId: 'test',
      contextStrategy: { strategy: 'off', windowSize: 5, messageThreshold: 12 },
      costSettings: { enabled: false, inputPrice: '', outputPrice: '' }, detailedStatistics: false })
    const source = createModelConfigurationTools({ db: f.db })
    await source.list_model_configurations.execute!({}, executionOptions('list'))
    const remove = f.wrap(source.delete_model_configuration, 'delete_model_configuration')
    const invoke = () => remove.execute!({ id, actionKey: 'delete' }, executionOptions('delete'))
    f.db.exec("CREATE TRIGGER broken BEFORE UPDATE ON tool_executions BEGIN SELECT RAISE(ABORT, 'receipt failed'); END")
    await expect(invoke()).rejects.toThrow('receipt failed')
    f.db.exec('DROP TRIGGER broken')
    await expect(invoke()).resolves.toMatchObject({ deleted: true })
  } finally { f.close() }
})
