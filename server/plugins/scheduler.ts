import { defineNitroPlugin } from 'nitropack/runtime'
import { createOpenAI } from '@ai-sdk/openai'
import { getChatDatabase } from '../persistence/db'
import { createSchedulerRepository } from '../scheduler/repository'
import { createSchedulerWorker } from '../scheduler/worker'
import { parseSchedulerMcpServer } from '../scheduler/config'
import { resolveChatConfig, type ChatRuntimeConfig } from '../utils/chat-request'

export default defineNitroPlugin((nitro) => {
  if (process.env.SCHEDULER_ENABLED === 'false') return
  const runtimeConfig = useRuntimeConfig() as ChatRuntimeConfig
  const worker = createSchedulerWorker({
    repository: createSchedulerRepository(getChatDatabase()),
    mcpServer: parseSchedulerMcpServer(process.env.SCHEDULER_MCP_SERVER_JSON),
    modelForReport: job => {
      const config = resolveChatConfig(runtimeConfig, job.modelId)
      return createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey }).chat(config.modelId)
    },
  })
  worker.start()
  nitro.hooks.hook('close', async () => { await worker.stop() })
})
