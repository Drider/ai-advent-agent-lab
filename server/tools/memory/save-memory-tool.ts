import type Database from 'better-sqlite3'
import { tool } from 'ai'
import { z } from 'zod'
import { createLongTermMemoryRepository } from '../../memory/long-term-repository'
import { createWorkingMemoryRepository } from '../../memory/working-repository'

const memoryInputSchema = z.object({
  layer: z.enum(['working', 'long_term']).describe('Memory layer explicitly requested by the user, or inferred from the fact type.'),
  category: z.enum(['goal', 'constraint', 'state', 'result', 'note', 'profile', 'decision', 'knowledge']),
  scope: z.enum(['current_project', 'global']).describe('Use current_project for project-specific information. Use global only for user facts or preferences intended to apply across projects.'),
  key: z.string().trim().min(1).max(80).describe('Short, stable title for this memory record.'),
  value: z.string().min(1).max(10_000).describe('The exact useful fact or project state to remember.'),
})

const WORKING_CATEGORIES = new Set(['goal', 'constraint', 'state', 'result', 'note'])
const LONG_TERM_CATEGORIES = new Set(['profile', 'decision', 'knowledge'])

export type SaveMemoryTool = ReturnType<typeof createSaveMemoryTool>

export function createSaveMemoryTool(options: {
  db?: Database.Database
  sessionId?: string
  projectId?: string
} = {}) {
  return tool({
    description: 'Save a memory record only when the user explicitly asks you to remember, save, or store information. Do not save facts merely because they may be useful. Use working for a current project goal, constraint, state, result, or note; use long_term for a stable profile fact, decision, or knowledge. Project scope always means the current chat project. Global scope applies across projects.',
    inputSchema: memoryInputSchema,
    execute: async ({ layer, category, scope, key, value }) => {
      if (!options.db || !options.sessionId) {
        return { saved: false, error: 'Memory saving is not configured for this chat.' }
      }

      if (layer === 'working') {
        if (!WORKING_CATEGORIES.has(category)) {
          return { saved: false, error: `Category "${category}" is not valid for working memory.` }
        }
        if (scope !== 'current_project') {
          return { saved: false, error: 'Working memory can only be saved to the current project.' }
        }
        if (!options.projectId) {
          return { saved: false, error: 'This chat is not attached to a project. Select or create a project before saving project memory.' }
        }

        const entry = createWorkingMemoryRepository(options.db).create({
          projectId: options.projectId,
          category: category as 'goal' | 'constraint' | 'state' | 'result' | 'note',
          key,
          value,
          sourceSessionId: options.sessionId,
        })
        return {
          saved: true,
          layer,
          scope,
          category: entry.category,
          key: entry.key,
          value: entry.value,
          id: entry.id,
        }
      }

      if (!LONG_TERM_CATEGORIES.has(category)) {
        return { saved: false, error: `Category "${category}" is not valid for long-term memory.` }
      }
      if (scope === 'current_project' && !options.projectId) {
        return { saved: false, error: 'This chat is not attached to a project. Select or create a project before saving project-scoped long-term memory.' }
      }

      const fact = createLongTermMemoryRepository(options.db).create({
        category: category as 'profile' | 'decision' | 'knowledge',
        key,
        value,
        global: scope === 'global',
        projectIds: scope === 'current_project' && options.projectId ? [options.projectId] : [],
        sourceSessionId: options.sessionId,
      })
      return {
        saved: true,
        layer,
        scope,
        category: fact.category,
        key: fact.key,
        value: fact.value,
        id: fact.id,
      }
    },
  })
}
