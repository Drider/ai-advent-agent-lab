import type Database from 'better-sqlite3'
import type { OnboardingProfilePreview, TaskSnapshot, TaskState } from '../../shared/task'
import {
  userProfileNameKey,
  type UserProfile,
} from '../../shared/user-profile'
import { createTaskRepository } from '../persistence/task-repository'
import { createUserProfileRepository } from '../persistence/user-profile-repository'

export const ONBOARDING_PROFILE_NAME = 'Новый пользователь'
export const ONBOARDING_GOAL = 'Познакомиться с новым пользователем до начала работы'

export function formatOnboardingInstructions(task: TaskState): string {
  const fields = [
    ['Обращаться к пользователю', 'name'],
    ['Сфера интересов пользователя', 'role'],
    ['Цель использования ассистента', 'goal'],
    ['Уровень пользователя в его сфере', 'level'],
    ['Стиль ответов', 'style'],
  ] as const

  return fields
    .map(([label, answerId]) => `${label} - ${task.answers[answerId] ?? '—'}`)
    .join('\n')
}

export function buildOnboardingPreview(db: Database.Database, task: TaskSnapshot): OnboardingProfilePreview {
  const profiles = createUserProfileRepository(db)
  const occupiedNames = new Set(profiles.list().map(profile => userProfileNameKey(profile.name)))
  // shortcut: имя режется до 70 символов, чтобы суффикс « (N)» влез в лимит 80
  const baseName = `Профиль - ${(task.answers.name ?? '').trim()}`.slice(0, 70)
  let name = baseName
  let suffix = 2
  while (occupiedNames.has(userProfileNameKey(name))) {
    name = `${baseName} (${suffix})`
    suffix += 1
  }
  return {
    name,
    instructions: formatOnboardingInstructions(task),
    taskRevision: task.revision,
  }
}

export function completeOnboarding(
  db: Database.Database,
  task: TaskState,
  preview: Pick<OnboardingProfilePreview, 'name' | 'instructions'>,
): UserProfile {
  const profiles = createUserProfileRepository(db)
  const profile = profiles.create({
    name: preview.name,
    instructions: preview.instructions,
  })
  return profiles.selectForSession(task.sessionId, profile.id)
}

export function startOnboardingIfNeeded(db: Database.Database, sessionId: string, profileName: string): TaskState | undefined {
  const tasks = createTaskRepository(db)
  const latest = tasks.getForSession(sessionId)
  if (latest !== undefined || userProfileNameKey(profileName) !== userProfileNameKey(ONBOARDING_PROFILE_NAME)) {
    return latest
  }
  return tasks.start(sessionId, { templateId: 'onboarding', goal: ONBOARDING_GOAL })
}
