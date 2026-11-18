import { defineEventHandler, setHeader } from 'h3'
import { getChatDatabase } from '../../persistence/db'
import { createModelConfigurationRepository } from '../../persistence/model-configuration-repository'

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  return createModelConfigurationRepository(getChatDatabase()).list()
})
