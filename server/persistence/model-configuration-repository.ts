import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { modelConfigurationNameKey, validateModelConfiguration, type ModelConfiguration, type ModelConfigurationInput } from '../../shared/model-config'

interface ModelConfigurationRow {
  id: string
  name: string
  model_id: string
  configuration_json: string
  created_at: string
  updated_at: string
}

function decodeConfiguration(row: ModelConfigurationRow): ModelConfiguration {
  const configuration = validateModelConfiguration(JSON.parse(row.configuration_json) as unknown)
  if (configuration.name !== row.name || configuration.modelId !== row.model_id) {
    throw new Error(`stored model configuration ${row.id} is inconsistent`)
  }
  return {
    ...configuration,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createModelConfigurationRepository(db: Database.Database) {
  function list(): ModelConfiguration[] {
    const rows = db.prepare(`
      SELECT id, name, model_id, configuration_json, created_at, updated_at
      FROM model_configurations
      ORDER BY updated_at DESC, id DESC
    `).all() as ModelConfigurationRow[]
    return rows.map(decodeConfiguration)
  }

  const saveTransaction = db.transaction((configuration: ModelConfigurationInput) => {
    const timestamp = new Date().toISOString()
    const nameKey = modelConfigurationNameKey(configuration.name)
    const existing = db.prepare(`
      SELECT id, created_at
      FROM model_configurations
      WHERE name_key = ?
    `).get(nameKey) as { id: string; created_at: string } | undefined
    const id = existing?.id ?? randomUUID()
    const createdAt = existing?.created_at ?? timestamp

    if (existing) {
      const result = db.prepare(`
        UPDATE model_configurations
        SET name = ?, name_key = ?, model_id = ?, configuration_json = ?, updated_at = ?
        WHERE id = ?
      `).run(configuration.name, nameKey, configuration.modelId, JSON.stringify(configuration), timestamp, id)
      if (result.changes !== 1) throw new Error('model configuration changed while saving')
    } else {
      db.prepare(`
        INSERT INTO model_configurations
          (id, name, name_key, model_id, configuration_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, configuration.name, nameKey, configuration.modelId, JSON.stringify(configuration), createdAt, timestamp)
    }

    return {
      configuration: { ...configuration, id, createdAt, updatedAt: timestamp },
      replaced: existing !== undefined,
    }
  })

  function saveWithResult(input: unknown): { configuration: ModelConfiguration; replaced: boolean } {
    return saveTransaction.immediate(validateModelConfiguration(input))
  }

  function save(input: unknown): ModelConfiguration {
    return saveWithResult(input).configuration
  }

  function remove(id: string): boolean {
    return db.prepare('DELETE FROM model_configurations WHERE id = ?').run(id).changes === 1
  }

  return { list, save, saveWithResult, delete: remove }
}
