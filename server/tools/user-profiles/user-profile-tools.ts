import type Database from 'better-sqlite3'
import { tool } from 'ai'
import { z } from 'zod'
import { createUserProfileRepository, UserProfileError } from '../../persistence/user-profile-repository'

const idSchema = z.string().uuid()
const createSchema = z.object({
  name: z.string(),
  instructions: z.string(),
}).strict()
const updateSchema = z.object({
  id: idSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
  name: z.string().optional(),
  instructions: z.string().optional(),
}).strict().refine(input => input.name !== undefined || input.instructions !== undefined, {
  message: 'At least one of name or instructions must be provided.',
})

export type UserProfileTools = ReturnType<typeof createUserProfileTools>

function errorResult(error: unknown) {
  if (error instanceof UserProfileError) {
    return { code: error.code, message: error.message }
  }
  return { code: 'UNAVAILABLE', message: 'User profile operation is unavailable.' }
}

export function createUserProfileTools(options: {
  db?: Database.Database
  sessionId?: string
  turnId?: string
} = {}) {
  const unavailable = { code: 'UNAVAILABLE', message: 'User profile storage is unavailable.' }
  const listedIds = new Set<string>()
  const repository = () => options.db ? createUserProfileRepository(options.db) : undefined

  return {
    list_user_profiles: tool({
      description: 'List profile IDs, names and revisions, including which profile is assigned to this chat and which is the default for new chats.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const profiles = repository()
        if (!profiles || !options.sessionId) return { ok: false as const, error: unavailable }
        try {
          const listed = profiles.list()
          listedIds.clear()
          for (const profile of listed) listedIds.add(profile.id)
          return {
            ok: true as const,
            profiles: listed,
            currentProfileId: profiles.getForSession(options.sessionId)?.id,
            defaultProfileId: profiles.getDefaultId(),
          }
        } catch (error) {
          return { ok: false as const, error: errorResult(error) }
        }
      },
    }),
    delete_user_profile: tool({
      description: 'Delete a user profile only after the user explicitly asks and list_user_profiles has returned the requested profile ID. Never delete the default profile or a profile assigned to a chat.',
      inputSchema: z.object({ id: idSchema }).strict(),
      execute: async ({ id }) => {
        const profiles = repository()
        if (!profiles) return { deleted: false as const, error: unavailable }
        if (!listedIds.has(id)) {
          return { deleted: false as const, error: { code: 'NOT_LISTED', message: 'List user profiles before deleting one.' } }
        }
        try {
          const deleted = profiles.delete(id)
          if (!deleted) return { deleted: false as const, error: { code: 'NOT_FOUND', message: 'User profile was not found.' } }
          listedIds.delete(id)
          return { deleted: true as const, id }
        } catch (error) {
          return { deleted: false as const, error: errorResult(error) }
        }
      },
    }),
    get_user_profile: tool({
      description: 'Get the full instructions for a profile. Omit id to read the profile currently assigned to this chat. Read the complete current text before making a semantic edit.',
      inputSchema: z.object({ id: idSchema.optional() }).strict(),
      execute: async ({ id }) => {
        const profiles = repository()
        if (!profiles || (!id && !options.sessionId)) return { ok: false as const, error: unavailable }
        try {
          const profile = id ? profiles.get(id) : profiles.getForSession(options.sessionId!)
          return profile
            ? { ok: true as const, profile }
            : { ok: false as const, error: { code: 'NOT_FOUND', message: 'User profile was not found.' } }
        } catch (error) {
          return { ok: false as const, error: errorResult(error) }
        }
      },
    }),
    create_user_profile: tool({
      description: 'Create a profile only when the user explicitly asks to create one. Supply the exact name and full instruction text requested. Creating it does not change any chat assignment or the default profile.',
      inputSchema: createSchema,
      execute: async (input) => {
        const profiles = repository()
        if (!profiles) return { created: false as const, error: unavailable }
        try {
          const profile = profiles.create(input)
          return { created: true as const, profile, chatAssignmentChanged: false as const, defaultChanged: false as const }
        } catch (error) {
          return { created: false as const, error: errorResult(error) }
        }
      },
    }),
    update_user_profile: tool({
      description: 'Update only the supplied fields of a profile after the user explicitly requests an edit. Before a semantic edit, read the complete profile; preserve every instruction the user did not ask to change. Use the current revision from that read.',
      inputSchema: updateSchema,
      execute: async ({ id, ...patch }) => {
        const profiles = repository()
        if (!profiles) return { updated: false as const, error: unavailable }
        try {
          const profile = profiles.update(id, patch)
          return { updated: true as const, profile, appliesFromNextTurn: true as const }
        } catch (error) {
          return { updated: false as const, error: errorResult(error) }
        }
      },
    }),
    select_user_profile: tool({
      description: 'Assign an existing profile to this chat only after the user explicitly asks to switch it. Never accept a session or turn ID from model input. The current turn keeps its original profile; the selection applies from the next turn.',
      inputSchema: z.object({ id: idSchema }).strict(),
      execute: async ({ id }) => {
        const profiles = repository()
        if (!profiles || !options.sessionId || !options.turnId) return { selected: false as const, error: unavailable }
        try {
          const profile = profiles.selectForSession(options.sessionId, id, { turnId: options.turnId })
          return { selected: true as const, profile, appliesFromNextTurn: true as const }
        } catch (error) {
          return { selected: false as const, error: errorResult(error) }
        }
      },
    }),
  }
}
