import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { openChatDatabase } from '../server/persistence/db'
import { createSessionRepository } from '../server/persistence/session-repository'
import { createTaskRepository } from '../server/persistence/task-repository'
import { createTurnRepository } from '../server/persistence/turn-repository'
import { createUserProfileRepository } from '../server/persistence/user-profile-repository'
import { buildOnboardingPreview } from '../server/tasks/onboarding'

const databases: ReturnType<typeof openChatDatabase>[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function database() {
  const db = openChatDatabase(':memory:')
  databases.push(db)
  return db
}

function reserveTurn(db: ReturnType<typeof database>, sessionId: string): string {
  return createTurnRepository(db).beginUserTurn({
    sessionId,
    requestId: randomUUID(),
    modelId: 'mock-model',
    message: { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Продолжим' }] },
    agentConfig: {},
  }).turnId
}

function finishTurn(db: ReturnType<typeof database>, turnId: string): void {
  createTurnRepository(db).finishTurn({
    turnId,
    message: { id: randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Готово' }] },
    status: 'completed',
  })
}

function finishOnboarding(db: ReturnType<typeof database>, sessionId: string, answers: Record<string, string>) {
  const tasks = createTaskRepository(db)
  const task = tasks.start(sessionId, { templateId: 'onboarding', goal: 'Познакомиться' })
  const answerTurn = reserveTurn(db, sessionId)
  for (const [questionId, answer] of Object.entries(answers)) {
    tasks.recordAnswer(sessionId, { questionId, answer }, { turnId: answerTurn })
  }
  finishTurn(db, answerTurn)

  const reviewTurn = reserveTurn(db, sessionId)
  tasks.requestTransition(sessionId, { to: 'review', summary: 'Ответы собраны' }, { turnId: reviewTurn })
  finishTurn(db, reviewTurn)
  tasks.approve(sessionId, 'review')

  const review = tasks.getSnapshot(sessionId)!
  const preview = buildOnboardingPreview(db, review)
  const doneTurn = reserveTurn(db, sessionId)
  const pending = tasks.requestTransition(sessionId, {
    to: 'done',
    summary: 'Профиль готов',
    expectedRevision: review.revision,
  }, { turnId: doneTurn })
  finishTurn(db, doneTurn)
  return {
    task,
    preview,
    pending,
    result: tasks.approve(sessionId, {
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
      expectedProfileName: preview.name,
    }),
  }
}

const answers = {
  name: 'Игорь',
  role: 'Разработчик',
  goal: 'Учёба',
  level: 'средний',
  style: 'кратко',
}

describe('onboarding task', () => {
  it('creates and selects a profile from answers when onboarding reaches done', () => {
    const db = database()
    const session = createSessionRepository(db).createSession()

    const { preview, result } = finishOnboarding(db, session.id, answers)
    const profile = createUserProfileRepository(db).getForSession(session.id)

    expect(result).toMatchObject({ status: 'done', stage: 'done' })
    expect(profile?.name).toBe('Профиль - Игорь')
    expect(profile?.instructions).toBe([
      'Обращаться к пользователю - Игорь',
      'Сфера интересов пользователя - Разработчик',
      'Цель использования ассистента - Учёба',
      'Уровень пользователя в его сфере - средний',
      'Стиль ответов - кратко',
    ].join('\n'))
    expect(profile).toMatchObject({ name: preview.name, instructions: preview.instructions })
    expect(preview.taskRevision).toBeLessThan(result.revision)
  })

  it('adds a numeric suffix instead of overwriting a profile with the same name', () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const profiles = createUserProfileRepository(db)
    const old = profiles.create({ name: 'Профиль - Игорь', instructions: 'старое' })

    finishOnboarding(db, session.id, answers)

    expect(profiles.getForSession(session.id)?.name).toBe('Профиль - Игорь (2)')
    expect(profiles.get(old.id)?.instructions).toBe('старое')
  })

  it('trims a long name to fit the profile name limit', () => {
    const db = database()
    const session = createSessionRepository(db).createSession()

    finishOnboarding(db, session.id, { ...answers, name: 'Я'.repeat(200) })

    expect(createUserProfileRepository(db).getForSession(session.id)?.name.length).toBeLessThanOrEqual(80)
  })

  it('returns from review to interview without creating a profile', () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'onboarding', goal: 'Познакомиться' })
    const answerTurn = reserveTurn(db, session.id)
    for (const [questionId, answer] of Object.entries(answers)) {
      tasks.recordAnswer(session.id, { questionId, answer }, { turnId: answerTurn })
    }
    finishTurn(db, answerTurn)
    const reviewTurn = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'review', summary: 'Ответы собраны' }, { turnId: reviewTurn })
    finishTurn(db, reviewTurn)
    tasks.approve(session.id, 'review')
    const before = createUserProfileRepository(db).list().length

    const interviewTurn = reserveTurn(db, session.id)
    tasks.requestTransition(session.id, { to: 'interview', summary: 'Нужно уточнение' }, { turnId: interviewTurn })
    finishTurn(db, interviewTurn)
    expect(tasks.approve(session.id, 'interview')).toMatchObject({ stage: 'interview', status: 'active' })
    expect(createUserProfileRepository(db).list()).toHaveLength(before)
  })

  it('does not create a profile when the confirmed preview name became stale', () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const tasks = createTaskRepository(db)
    tasks.start(session.id, { templateId: 'onboarding', goal: 'Познакомиться' })
    const answerTurn = reserveTurn(db, session.id)
    for (const [questionId, answer] of Object.entries(answers)) {
      tasks.recordAnswer(session.id, { questionId, answer }, { turnId: answerTurn })
    }
    const reviewPending = tasks.requestTransition(session.id, { to: 'review', summary: 'Ответы' }, { turnId: answerTurn })
    finishTurn(db, answerTurn)
    tasks.approve(session.id, { pendingTransitionId: reviewPending.pendingTransition!.id, expectedRevision: reviewPending.revision })
    const review = tasks.getSnapshot(session.id)!
    const preview = buildOnboardingPreview(db, review)
    const doneTurn = reserveTurn(db, session.id)
    const donePending = tasks.requestTransition(session.id, {
      to: 'done', summary: 'Профиль', expectedRevision: review.revision,
    }, { turnId: doneTurn })
    finishTurn(db, doneTurn)
    createUserProfileRepository(db).create({ name: preview.name, instructions: 'коллизия' })
    const selectedBefore = createUserProfileRepository(db).getForSession(session.id)

    expect(() => tasks.approve(session.id, {
      pendingTransitionId: donePending.pendingTransition!.id,
      expectedRevision: donePending.revision,
      expectedProfileName: preview.name,
    })).toThrowError(expect.objectContaining({
      code: 'PROFILE_PREVIEW_CONFLICT',
      snapshot: expect.objectContaining({
        profilePreview: expect.objectContaining({ name: 'Профиль - Игорь (2)' }),
      }),
    }))
    expect(createUserProfileRepository(db).getForSession(session.id)?.id).toBe(selectedBefore?.id)
    expect(tasks.getSnapshot(session.id)).toMatchObject({
      stage: 'review',
      pendingTransition: { id: donePending.pendingTransition!.id },
    })
  })

  it('keeps terminal onboarding approval idempotent without duplicate profiles', () => {
    const db = database()
    const session = createSessionRepository(db).createSession()
    const profiles = createUserProfileRepository(db)
    const before = profiles.list().length
    const { pending, preview, result } = finishOnboarding(db, session.id, answers)

    const repeated = createTaskRepository(db).approve(session.id, {
      pendingTransitionId: pending.pendingTransition!.id,
      expectedRevision: pending.revision,
      expectedProfileName: preview.name,
    })

    expect(repeated).toEqual(result)
    expect(profiles.list()).toHaveLength(before + 1)
  })
})
