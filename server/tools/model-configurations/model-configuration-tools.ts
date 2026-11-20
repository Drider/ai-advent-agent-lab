import type Database from 'better-sqlite3'
import { sqliteExecute } from '../sqlite-execute'
import { tool } from 'ai'
import { z } from 'zod'
import { validateModelConfigurationSaveRequest, type ModelConfigurationInput } from '../../../shared/model-config'
import { createModelConfigurationRepository } from '../../persistence/model-configuration-repository'

const contextStrategySchema = z.object({
  strategy: z.enum(['off', 'summary', 'sliding_window', 'sticky_facts']),
  windowSize: z.number().int().min(1).max(10_000),
  messageThreshold: z.number().int().min(12).max(10_000),
}).strict()

const configurationSchema = z.object({
  modelId: z.string().trim().min(1).max(200).refine(value => !/\s/u.test(value)),
  contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  contextStrategy: contextStrategySchema,
  costSettings: z.object({
    enabled: z.boolean(),
    inputPrice: z.string(),
    outputPrice: z.string(),
  }).strict(),
  detailedStatistics: z.boolean(),
}).strict()

const saveRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  configuration: configurationSchema,
}).strict()

export type ModelConfigurationTools = ReturnType<typeof createModelConfigurationTools>

export function createModelConfigurationTools(options: { db?: Database.Database } = {}) {
  const listedIds = new Set<string>()
  const unavailable = { code: 'UNAVAILABLE', message: 'Model configuration storage is unavailable.' }

  return {
    save_model_configuration: tool({
      description: 'Save the exact model configuration explicitly requested by the user. Include a name, modelId, optional contextWindowTokens, contextStrategy, costSettings, and detailedStatistics. Saving an existing name updates that saved configuration; report whether it was updated.',
      inputSchema: saveRequestSchema,
      execute: sqliteExecute((request) => {
        if (!options.db) return { saved: false as const, error: unavailable }
        let configuration: ModelConfigurationInput
        try {
          configuration = validateModelConfigurationSaveRequest(request)
        } catch (error) {
          return { saved: false as const, error: { code: 'INVALID_CONFIGURATION', message: error instanceof Error ? error.message : 'Invalid model configuration' } }
        }
        const result = createModelConfigurationRepository(options.db).saveWithResult(configuration)
        return { saved: true as const, ...result }
      }),
    }),
    list_model_configurations: tool({
      description: 'List all saved model configurations with their exact settings. Use this when the user asks to see, inspect, or choose a saved configuration, and before deleting one.',
      inputSchema: z.object({}).strict(),
      execute: async () => {
        if (!options.db) return { ok: false as const, error: unavailable }
        const configurations = createModelConfigurationRepository(options.db).list()
        listedIds.clear()
        for (const configuration of configurations) listedIds.add(configuration.id)
        return { ok: true as const, configurations }
      },
    }),
    delete_model_configuration: tool({
      description: 'Delete a saved model configuration by ID returned by list_model_configurations during this turn. Never delete a profile before listing it and confirming the requested target matches.',
      inputSchema: z.object({ id: z.string().uuid() }).strict(),
      execute: sqliteExecute(({ id }) => {
        if (!options.db) return { deleted: false as const, error: unavailable }
        if (!listedIds.has(id)) {
          return { deleted: false as const, error: { code: 'NOT_LISTED', message: 'List saved model configurations before deleting one.' } }
        }
        const deleted = createModelConfigurationRepository(options.db).delete(id)
        // A failed outer receipt transaction restores the row. Keep its list permission available for that retry.
        if (!options.db.inTransaction) listedIds.delete(id)
        return deleted
          ? { deleted: true as const, id }
          : { deleted: false as const, error: { code: 'NOT_FOUND', message: 'Model configuration not found.' } }
      }),
    }),
  }
}
