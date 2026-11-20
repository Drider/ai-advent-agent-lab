import type Database from 'better-sqlite3'
import { sqliteExecute } from '../sqlite-execute'
import { tool } from 'ai'
import { z } from 'zod'
import { createLongTermMemoryRepository } from '../../memory/long-term-repository'
import { createWorkingMemoryRepository } from '../../memory/working-repository'

const memoryInputSchema = z.object({
  layer: z.enum(['working', 'long_term']).describe('Use working for requests to save to project memory unless long-term memory is explicitly requested. Use long_term only for explicit long-term, global, or cross-project memory requests; never infer it from the fact type.'),
  category: z.enum(['goal', 'constraint', 'state', 'result', 'note', 'profile', 'decision', 'knowledge']).describe('Choose within the requested layer: working uses goal, constraint, state, result, or note (including project knowledge and decisions); long_term uses profile, decision, or knowledge.'),
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
    description: 'Save a memory record only when the user explicitly asks you to remember, save, or store information. A request to save to project memory ("сохрани в память проекта") means working/current_project, even for knowledge or decisions: use category=note for these. Use long_term only when the user explicitly requests long-term, global, or cross-project memory. Global scope requires an explicit global or cross-project request. The requested layer takes priority over the content type. Project scope always means the current chat project.',
    inputSchema: memoryInputSchema,
    execute: sqliteExecute(({ layer, category, scope, key, value }) => {
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
    }),
  })
}
