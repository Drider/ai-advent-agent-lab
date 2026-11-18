import { createError, defineEventHandler, readBody, setHeader } from 'h3'
import { validateModelConfigurationSaveRequest, type ModelConfigurationInput } from '../../../shared/model-config'
import { getChatDatabase } from '../../persistence/db'
import { createModelConfigurationRepository } from '../../persistence/model-configuration-repository'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  let configuration: ModelConfigurationInput
  try {
    configuration = validateModelConfigurationSaveRequest(await readBody(event, { strict: true }) as unknown)
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Invalid model configuration',
    })
  }
  return createModelConfigurationRepository(getChatDatabase()).save(configuration)
})
