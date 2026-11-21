import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createProjectRepository } from '../server/persistence/project-repository'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createWorkingMemoryRepository } from '../server/memory/working-repository'
import { createMemorySettingsRepository } from '../server/memory/settings-repository'
import { startMemoryAwareTurn } from '../server/memory/start-turn'
import { MemoryError } from '../server/memory/errors'
import { createTaskRepository } from '../server/persistence/task-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'
import { ONBOARDING_PROFILE_NAME } from '../server/tasks/onboarding'
import { DEFAULT_COMPACTION_SETTINGS, DEFAULT_CONTEXT_STRATEGY_SETTINGS } from '../shared/chat'
import { buildAgentInstructions, getAgentConfig } from '../server/agent/chat-agent'
import { taskBlocksWrites, type TaskState } from '../shared/task'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const request = (sessionId: string) => ({
  kind: 'message' as const,
  sessionId,
  requestId: randomUUID(),
  message: { id: randomUUID(), role: 'user' as const, parts: [{ type: 'text' as const, text: 'continue' }] },
})

describe('memory-aware turn start', () => {
  function task(overrides: Partial<TaskState> = {}): TaskState {
    return {
      id: 'task-1',
      sessionId: 'session-1',
      templateId: 'dev',
      goal: 'Сделать задачу',
      stage: 'planning',
      step: '',
      status: 'active',
      artifacts: {},
      answers: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  it('does not create a turn when a memory layer exceeds its budget', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    createWorkingMemoryRepository(db).create({ projectId: project.id, category: 'goal', key: 'large', value: 'x'.repeat(10_000) })
    createMemorySettingsRepository(db).update({ workingTokens: 100, expectedRevision: 0 })

    expect(() => startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })).toThrow(MemoryError)
    expect(db.prepare('SELECT COUNT(*) AS count FROM turns').get()).toEqual({ count: 0 })
  })

  it('starts a turn with a fresh snapshot after memory changes', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const project = createProjectRepository(db).create('Alpha')
    const session = createSessionRepository(db).createSession({ projectId: project.id })
    const working = createWorkingMemoryRepository(db)
    working.create({ projectId: project.id, category: 'state', key: 'status', value: 'ready' })

    const started = startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })
    expect(started.turnId).toBeTruthy()
    expect(started.snapshot.workingEntries[0]?.value).toBe('ready')
    expect(db.prepare('SELECT status FROM turns WHERE id = ?').get(started.turnId)).toEqual({ status: 'running' })
  })

  it('puts the task snapshot and approved plan in instructions, not chat history', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'dev', goal: 'Сделать отчёт' })
    const createAgentConfig = (profile: any, task: any) => getAgentConfig(
      DEFAULT_COMPACTION_SETTINGS,
      DEFAULT_CONTEXT_STRATEGY_SETTINGS,
      profile,
      false,
      task,
    )

    const first = startMemoryAwareTurn(db, {
      request: request(session.id),
      modelId: 'mock',
      agentConfig: {},
      createAgentConfig,
    })
    tasks.requestTransition(session.id, { to: 'execution', summary: 'План: собрать данные и записать отчёт' }, { turnId: first.turnId })
    createTurnRepository(db).finishTurn({
      turnId: first.turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Предлагаю план' }] },
      status: 'completed',
    })
    tasks.approve(session.id, 'execution')

    const second = startMemoryAwareTurn(db, {
      request: request(session.id),
      modelId: 'mock',
      agentConfig: {},
      createAgentConfig,
    })
    expect(second.taskSnapshot).toMatchObject({ goal: 'Сделать отчёт', stage: 'execution', status: 'active' })
    expect(second.agentConfig.instructions).toContain('<task_state>')
    expect(second.agentConfig.instructions).toContain('План: собрать данные и записать отчёт')
    expect(JSON.stringify(second.snapshot.messages)).not.toContain('План: собрать данные и записать отчёт')
  })

  it.each(['done', 'cancelled'] as const)('omits finished task state from agent config for %s tasks', status => {
    const finished = task({ status, stage: status === 'done' ? 'done' : 'planning' })
    const config = getAgentConfig(
      DEFAULT_COMPACTION_SETTINGS,
      DEFAULT_CONTEXT_STRATEGY_SETTINGS,
      undefined,
      false,
      finished,
    )

    expect(config.instructions).not.toContain('<task_state>')
    expect(config).not.toHaveProperty('task')
    expect(taskBlocksWrites(finished)).toBe(false)
  })

  it('describes user-owned actions in task instructions', () => {
    expect(buildAgentInstructions(undefined, false, task({ status: 'paused' }))).toContain('Expected action: /task resume')
    expect(buildAgentInstructions(undefined, false, task({ pendingStage: 'execution', pendingSummary: 'План' }))).toContain(
      'Expected action: /task approve | /task reject',
    )
    expect(buildAgentInstructions(undefined, false, task({ status: 'paused' }))).toContain(
      'remind the user of that command and do not advance the task',
    )
    expect(buildAgentInstructions(undefined, false, task())).toContain(
      'Only report a stage change when applied=true or a fresh get_task_state snapshot proves it',
    )
  })

  it('starts onboarding on the first message of a dialogue with the new-user profile', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    const profiles = createUserProfileRepository(db)
    const profile = profiles.create({ name: ONBOARDING_PROFILE_NAME, instructions: '' })
    profiles.selectForSession(session.id, profile.id)

    const started = startMemoryAwareTurn(db, {
      request: request(session.id),
      modelId: 'mock',
      agentConfig: {},
      createAgentConfig: (profileSnapshot, taskSnapshot) => getAgentConfig(
        DEFAULT_COMPACTION_SETTINGS,
        DEFAULT_CONTEXT_STRATEGY_SETTINGS,
        profileSnapshot,
        false,
        taskSnapshot,
      ),
    })

    expect(started.taskSnapshot).toMatchObject({ templateId: 'onboarding', stage: 'interview' })
    expect(started.agentConfig.instructions).toContain('Анкета')
  })

  it('does not start onboarding for other profiles', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const session = createSessionRepository(db).createSession()
    const started = startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })

    expect(started.taskSnapshot).toBeUndefined()
  })

  it('does not start onboarding again after cancellation or when a dialogue already had a task', () => {
    const db = openChatDatabase(':memory:')
    databases.push(db)
    const sessions = createSessionRepository(db)
    const session = sessions.createSession()
    const profiles = createUserProfileRepository(db)
    const profile = profiles.create({ name: ONBOARDING_PROFILE_NAME, instructions: '' })
    profiles.selectForSession(session.id, profile.id)

    const first = startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })
    createTurnRepository(db).finishTurn({
      turnId: first.turnId,
      message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Начнём' }] },
      status: 'completed',
    })
    createTaskRepository(db).cancel(session.id)
    const second = startMemoryAwareTurn(db, { request: request(session.id), modelId: 'mock', agentConfig: {} })

    expect(second.taskSnapshot).toMatchObject({ status: 'cancelled', templateId: 'onboarding' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE session_id = ?').get(session.id)).toEqual({ count: 1 })

    const otherSession = sessions.createSession()
    createTaskRepository(db).start(otherSession.id, { templateId: 'dev', goal: 'Старая задача' })
    profiles.selectForSession(otherSession.id, profile.id)
    const existing = startMemoryAwareTurn(db, { request: request(otherSession.id), modelId: 'mock', agentConfig: {} })
    expect(existing.taskSnapshot).toMatchObject({ templateId: 'dev' })
  })
})
