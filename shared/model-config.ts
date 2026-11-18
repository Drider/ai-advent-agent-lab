import {
  validateContextStrategySettings,
  validateModelId,
  type ChatContextStrategySettings,
  type ChatCostSettings,
} from './chat'

export interface ModelConfigurationInput {
  name: string
  modelId: string
  contextWindowTokens?: number
  contextStrategy: ChatContextStrategySettings
  costSettings: ChatCostSettings
  detailedStatistics: boolean
}

export interface ModelConfiguration extends ModelConfigurationInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface ModelConfigurationSaveRequest {
  name: string
  configuration: Omit<ModelConfigurationInput, 'name'>
}

export function modelConfigurationNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim()
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false
    }
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key))
}

export function validateModelConfiguration(input: unknown): ModelConfigurationInput {
  const requiredKeys = ['name', 'modelId', 'contextStrategy', 'costSettings', 'detailedStatistics']
  if (!isRecord(input) || !hasExactKeys(input, requiredKeys, ['contextWindowTokens'])) {
    throw new Error('configuration must contain only name, modelId, optional contextWindowTokens, contextStrategy, costSettings, and detailedStatistics')
  }

  if (typeof input.name !== 'string') throw new Error('configuration name must be a string')
  const name = input.name.trim()
  if (name.length < 1 || name.length > 80) throw new Error('configuration name must be 1 to 80 characters')
  if (!isWellFormedUnicode(name) || name.includes('\0')) throw new Error('configuration name must contain valid Unicode text')

  const contextWindowTokens = input.contextWindowTokens
  if (contextWindowTokens !== undefined
    && (typeof contextWindowTokens !== 'number'
      || !Number.isSafeInteger(contextWindowTokens)
      || contextWindowTokens <= 0)) {
    throw new Error('contextWindowTokens must be a positive safe integer')
  }

  if (!isRecord(input.contextStrategy)
    || !hasExactKeys(input.contextStrategy, ['strategy', 'windowSize', 'messageThreshold'])) {
    throw new Error('contextStrategy must contain only strategy, windowSize, and messageThreshold')
  }
  const contextStrategy = validateContextStrategySettings(input.contextStrategy)

  if (!isRecord(input.costSettings)
    || !hasExactKeys(input.costSettings, ['enabled', 'inputPrice', 'outputPrice'])
    || typeof input.costSettings.enabled !== 'boolean'
    || typeof input.costSettings.inputPrice !== 'string'
    || typeof input.costSettings.outputPrice !== 'string') {
    throw new Error('costSettings must contain only a boolean enabled flag and string inputPrice and outputPrice values')
  }

  if (typeof input.detailedStatistics !== 'boolean') {
    throw new Error('detailedStatistics must be a boolean')
  }

  const modelId = validateModelId(input.modelId)
  if (!isWellFormedUnicode(modelId) || modelId.includes('\0')) throw new Error('modelId must contain valid Unicode text')

  return {
    name,
    modelId,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    contextStrategy,
    costSettings: {
      enabled: input.costSettings.enabled,
      inputPrice: input.costSettings.inputPrice,
      outputPrice: input.costSettings.outputPrice,
    },
    detailedStatistics: input.detailedStatistics,
  }
}

export function validateModelConfigurationSaveRequest(input: unknown): ModelConfigurationInput {
  if (!isRecord(input) || !hasExactKeys(input, ['name', 'configuration']) || typeof input.name !== 'string') {
    throw new Error('request must contain only a name and configuration')
  }
  if (!isRecord(input.configuration)
    || !hasExactKeys(input.configuration, ['modelId', 'contextStrategy', 'costSettings', 'detailedStatistics'], ['contextWindowTokens'])) {
    throw new Error('configuration must contain only modelId, optional contextWindowTokens, contextStrategy, costSettings, and detailedStatistics')
  }
  return validateModelConfiguration({ ...input.configuration, name: input.name })
}
