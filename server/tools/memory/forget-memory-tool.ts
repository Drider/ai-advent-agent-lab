import type Database from 'better-sqlite3'
import { tool } from 'ai'
import { z } from 'zod'
import { createLongTermMemoryRepository } from '../../memory/long-term-repository'
import { createWorkingMemoryRepository } from '../../memory/working-repository'

const memoryInputSchema = z.object({
  layer: z.enum(['working', 'long_term']),
  scope: z.enum(['current_project', 'global']),
  key: z.string().trim().min(1).max(80),
})

export type ForgetMemoryTool = ReturnType<typeof createForgetMemoryTool>

export function createForgetMemoryTool(options: {
  db?: Database.Database
  sessionId?: string
  projectId?: string
} = {}) {
  return tool({
    description: 'Forget memory records by their exact key. Use the same key that appears in the memory block. Use current_project for project memory and global only for explicitly global long-term memory.',
    inputSchema: memoryInputSchema,
    execute: async ({ layer, scope, key }) => {
      if (!options.db || !options.sessionId) {
        return { forgotten: false, error: 'Memory forgetting is not configured for this chat.' }
      }
      if (layer === 'working') {
        if (scope !== 'current_project') return { forgotten: false, error: 'Working memory can only be forgotten from the current project.' }
        if (!options.projectId) return { forgotten: false, error: 'This chat is not attached to a project. Select or create a project before forgetting project memory.' }
        const values = createWorkingMemoryRepository(options.db).forgetByKey(options.projectId, key)
        return { forgotten: true, layer, scope, key, count: values.length, values }
      }
      if (scope === 'current_project' && !options.projectId) {
        return { forgotten: false, error: 'This chat is not attached to a project. Select or create a project before forgetting project-scoped long-term memory.' }
      }
      const values = createLongTermMemoryRepository(options.db).forgetByKey(
        scope === 'global' ? { global: true } : { projectId: options.projectId },
        key,
      )
      return { forgotten: true, layer, scope, key, count: values.length, values }
    },
  })
}
