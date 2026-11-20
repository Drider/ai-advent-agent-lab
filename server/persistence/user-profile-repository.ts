import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  validateUserProfileCreate,
  validateUserProfileUpdate,
  userProfileNameKey,
  type CreateUserProfileInput,
  type UpdateUserProfileInput,
  type UpdateProfileWorkflowInput,
  type UserProfile,
  type UserProfileSummary,
} from '../../shared/user-profile'

const PROFILE_FIELDS = 'id, name, instructions, revision, default_workflow_id, created_at, updated_at'

interface UserProfileRow {
  id: string
  name: string
  instructions: string
  revision: number
  default_workflow_id: string | null
  created_at: string
  updated_at: string
}

function toProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    revision: row.revision,
    defaultWorkflowId: row.default_workflow_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSummary(profile: UserProfile): UserProfileSummary {
  const { instructions: _instructions, ...summary } = profile
  return summary
}

export class UserProfileError extends Error {
  constructor(
    public readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'NAME_CONFLICT' | 'REVISION_CONFLICT' | 'SESSION_RUNNING' | 'TURN_NOT_ACTIVE',
    message: string,
  ) {
    super(message)
    this.name = 'UserProfileError'
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && error.code.includes('CONSTRAINT_UNIQUE')
}

export function createUserProfileRepository(db: Database.Database) {
  function get(id: string): UserProfile | undefined {
    const row = db.prepare(`SELECT ${PROFILE_FIELDS} FROM user_profiles WHERE id = ?`).get(id) as UserProfileRow | undefined
    return row ? toProfile(row) : undefined
  }

  function list(): UserProfileSummary[] {
    const rows = db.prepare(`SELECT ${PROFILE_FIELDS} FROM user_profiles ORDER BY name_key, id`).all() as UserProfileRow[]
    return rows.map(row => toSummary(toProfile(row)))
  }

  function getDefault(): UserProfile {
    const row = db.prepare(`
      SELECT p.${PROFILE_FIELDS.split(', ').join(', p.')}
      FROM user_profile_settings s JOIN user_profiles p ON p.id = s.default_profile_id
      WHERE s.id = 1
    `).get() as UserProfileRow | undefined
    if (!row) throw new UserProfileError('NOT_FOUND', 'default profile was not found')
    return toProfile(row)
  }

  function getForSession(sessionId: string): UserProfile | undefined {
    const row = db.prepare(`
      SELECT p.${PROFILE_FIELDS.split(', ').join(', p.')}
      FROM sessions s JOIN user_profiles p ON p.id = s.user_profile_id
      WHERE s.id = ?
    `).get(sessionId) as UserProfileRow | undefined
    return row ? toProfile(row) : undefined
  }

  function getForTurn(sessionId: string, turnId?: string): UserProfile {
    if (turnId !== undefined) {
      const active = db.prepare(`SELECT 1 FROM turns WHERE id = ? AND session_id = ? AND status = 'running'`).get(turnId, sessionId)
      if (!active) throw new UserProfileError('TURN_NOT_ACTIVE', 'profile changes require the current running turn')
    }
    const profile = getForSession(sessionId)
    if (!profile) throw new UserProfileError('NOT_FOUND', 'session or assigned profile was not found')
    return profile
  }

  function getDefaultId(): string {
    const row = db.prepare('SELECT default_profile_id FROM user_profile_settings WHERE id = 1').get() as { default_profile_id: string } | undefined
    if (!row) throw new UserProfileError('NOT_FOUND', 'default profile was not found')
    return row.default_profile_id
  }

  function create(input: unknown): UserProfile {
    let profile: CreateUserProfileInput
    try {
      profile = validateUserProfileCreate(input)
    } catch (error) {
      throw new UserProfileError('INVALID_INPUT', error instanceof Error ? error.message : 'invalid profile')
    }
    const id = randomUUID()
    const timestamp = new Date().toISOString()
    try {
      db.prepare(`
        INSERT INTO user_profiles (id, name, name_key, instructions, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(id, profile.name, userProfileNameKey(profile.name), profile.instructions, timestamp, timestamp)
    } catch (error) {
      if (isUniqueConstraint(error)) throw new UserProfileError('NAME_CONFLICT', 'a profile with this name already exists')
      throw error
    }
    return get(id)!
  }

  function update(id: string, input: unknown): UserProfile {
    let patch: UpdateUserProfileInput
    try {
      patch = validateUserProfileUpdate(input)
    } catch (error) {
      throw new UserProfileError('INVALID_INPUT', error instanceof Error ? error.message : 'invalid profile update')
    }
    const transaction = db.transaction(() => {
      const current = get(id)
      if (!current) throw new UserProfileError('NOT_FOUND', 'profile was not found')
      if (current.revision !== patch.expectedRevision) throw new UserProfileError('REVISION_CONFLICT', 'profile was changed by another request')
      const name = patch.name ?? current.name
      const instructions = patch.instructions ?? current.instructions
      try {
        db.prepare(`
          UPDATE user_profiles
          SET name = ?, name_key = ?, instructions = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(name, userProfileNameKey(name), instructions, new Date().toISOString(), id, patch.expectedRevision)
      } catch (error) {
        if (isUniqueConstraint(error)) throw new UserProfileError('NAME_CONFLICT', 'a profile with this name already exists')
        throw error
      }
      return get(id)!
    })
    return transaction.immediate()
  }

  function setDefault(id: string): UserProfile {
    const transaction = db.transaction(() => {
      if (!get(id)) throw new UserProfileError('NOT_FOUND', 'profile was not found')
      db.prepare('UPDATE user_profile_settings SET default_profile_id = ?, updated_at = ? WHERE id = 1')
        .run(id, new Date().toISOString())
      return get(id)!
    })
    return transaction.immediate()
  }

  function setWorkflow(id: string, input: UpdateProfileWorkflowInput): UserProfile {
    return db.transaction(() => {
      const current = get(id)
      if (!current) throw new UserProfileError('NOT_FOUND', 'Profile was not found')
      if (current.revision !== input.expectedRevision) throw new UserProfileError('REVISION_CONFLICT', 'Profile revision changed')
      if (input.workflowId !== null && !db.prepare('SELECT 1 FROM workflow_versions WHERE workflow_id = ?').get(input.workflowId)) {
        throw new UserProfileError('NOT_FOUND', 'Workflow was not found')
      }
      db.prepare('UPDATE user_profiles SET default_workflow_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(input.workflowId, new Date().toISOString(), id)
      return get(id)!
    }).immediate()
  }

  function selectForSession(sessionId: string, profileId: string, options: { turnId?: string } = {}): UserProfile {
    const transaction = db.transaction(() => {
      const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string } | undefined
      if (!session) throw new UserProfileError('NOT_FOUND', 'session was not found')
      if (!get(profileId)) throw new UserProfileError('NOT_FOUND', 'profile was not found')
      if (options.turnId === undefined) {
        if (session.status === 'running' || db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
          throw new UserProfileError('SESSION_RUNNING', 'profile cannot be changed while the session is running')
        }
      } else if (!db.prepare("SELECT 1 FROM turns WHERE id = ? AND session_id = ? AND status = 'running'").get(options.turnId, sessionId)) {
        throw new UserProfileError('TURN_NOT_ACTIVE', 'profile changes require the current running turn')
      }
      db.prepare('UPDATE sessions SET user_profile_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(profileId, new Date().toISOString(), sessionId)
      return get(profileId)!
    })
    return transaction.immediate()
  }

  return { list, get, getDefault, getDefaultId, getForSession, getForTurn, create, update, setDefault, setWorkflow, selectForSession }
}
