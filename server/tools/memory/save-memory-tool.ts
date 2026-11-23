import type Database from 'better-sqlite3'
import { tool } from 'ai'
import { z } from 'zod'
import { createLongTermMemoryRepository } from '../../memory/long-term-repository'
import { createWorkingMemoryRepository } from '../../memory/working-repository'

const memoryInputSchema = z.object({
  layer: z.enum(['working', 'long_term']).describe('Use working for requests to save to project memory unless long-term memory is explicitly requested. Use long_term only for explicit long-term, global, or cross-project memory requests; never infer it from the fact type.'),
  category: z.enum(['goal', 'constraint', 'state', 'result', 'note', 'profile', 'decision', 'knowledge']).describe('Choose within the requested layer: working uses goal for objectives, constraint for requirements or deadlines. Use state for current mutable facts such as selected approaches, versions, and statuses. Use result for completed outcomes. Use note only for append-only observations or history. Long-term uses profile, decision, or knowledge.'),
  scope: z.enum(['current_project', 'global']).describe('Use current_project for project memory. Use global only when the user explicitly requests global or cross-project memory; global requires layer=long_term.'),
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
    description: 'Save a memory record only when the user explicitly asks you to remember, save, or store information. A request to save to project memory ("сохрани в память проекта") means working/current_project, even for stable knowledge or decisions. Use working/current_project for that request. Use state for current mutable facts such as selected approaches, versions, and statuses. Use constraint for requirements or deadlines. Use note only for append-only observations or history. Use long_term only when the user explicitly requests long-term, global, or cross-project memory. Global scope requires an explicit global or cross-project request. The requested layer takes priority over the content type. Project scope always means the current chat project. Overwriteable categories (goal, constraint, state, profile, knowledge) replace the current value under the same key; result, note, and decision are appended. To update a mutable fact, use both the same key and the state category as the memory block.',
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

        const result = createWorkingMemoryRepository(options.db).upsert({
          projectId: options.projectId,
          category: category as 'goal' | 'constraint' | 'state' | 'result' | 'note',
          key,
          value,
          sourceSessionId: options.sessionId,
        })
        const entry = result.entry
        return {
          saved: result.status !== 'stale',
          status: result.status,
          layer,
          scope,
          category: entry.category,
          key: entry.key,
          value: entry.value,
          id: entry.id,
          ...(result.previousValue === undefined ? {} : { previousValue: result.previousValue }),
        }
      }

      if (!LONG_TERM_CATEGORIES.has(category)) {
        return { saved: false, error: `Category "${category}" is not valid for long-term memory.` }
      }
      if (scope === 'current_project' && !options.projectId) {
        return { saved: false, error: 'This chat is not attached to a project. Select or create a project before saving project-scoped long-term memory.' }
      }

      const result = createLongTermMemoryRepository(options.db).upsert({
        category: category as 'profile' | 'decision' | 'knowledge',
        key,
        value,
        global: scope === 'global',
        projectIds: scope === 'current_project' && options.projectId ? [options.projectId] : [],
        sourceSessionId: options.sessionId,
      })
      const fact = result.entry
      return {
        saved: result.status !== 'stale',
        status: result.status,
        layer,
        scope,
        category: fact.category,
        key: fact.key,
        value: fact.value,
        id: fact.id,
        ...(result.previousValue === undefined ? {} : { previousValue: result.previousValue }),
      }
    },
  })
}
