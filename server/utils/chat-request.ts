import { validateUIMessages, type UIMessage } from 'ai'
import {
  DEFAULT_CHAT_MODEL,
  validateChatRequest,
  validateModelId,
  type ChatRequestBody,
} from '../../shared/chat'
import type { RunLogLevel } from './run-logger'

export const MAX_CHAT_BODY_BYTES = 256 * 1024

export interface ChatRuntimeConfig {
  llmBaseUrl: string
  llmApiKey: string
  llmLogLevel: unknown
  public: {
    chatDefaultModel?: string
  }
}

function getLogLevel(value: unknown): RunLogLevel {
  return value === 'off' || value === 'detailed' || value === 'raw' ? value : 'basic'
}

export async function parseChatPayload(raw: string): Promise<ChatRequestBody> {
  if (new TextEncoder().encode(raw).byteLength > MAX_CHAT_BODY_BYTES) {
    throw new Error('request body must be no larger than 256 KB')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('request body must be valid JSON')
  }

  const request = validateChatRequest(parsed)

  if (request.kind === 'continue') {
    return request
  }

  try {
    const messages = await validateUIMessages<UIMessage>({
      messages: [request.message],
    })

    return {
      ...request,
      message: messages[0]!,
    }
  } catch {
    throw new Error('messages must contain valid UIMessage entries')
  }
}

export function resolveChatConfig(
  config: ChatRuntimeConfig,
  requestedModel?: string,
): {
  baseURL: string
  apiKey: string
  modelId: string
  logLevel: RunLogLevel
} {
  const baseURL = typeof config.llmBaseUrl === 'string' ? config.llmBaseUrl.trim() : ''
  const apiKey = typeof config.llmApiKey === 'string' ? config.llmApiKey.trim() : ''

  if (!baseURL || !apiKey) {
    throw new Error('LLM server configuration is incomplete')
  }

  const modelId = validateModelId(
    requestedModel ?? config.public.chatDefaultModel ?? DEFAULT_CHAT_MODEL,
  )

  return {
    baseURL,
    apiKey,
    modelId,
    logLevel: getLogLevel(config.llmLogLevel),
  }
}
