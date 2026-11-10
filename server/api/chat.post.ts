import { createOpenAI } from '@ai-sdk/openai'
import { createError, defineEventHandler, readRawBody } from 'h3'
import type { ChatRuntimeConfig } from '../utils/chat-request'
import { parseChatPayload, resolveChatConfig } from '../utils/chat-request'
import { streamChatAgent } from '../agent/chat-agent'
import { getChatDatabase } from '../persistence/db'
import { createSessionRepository } from '../persistence/session-repository'
import { buildSessionContext } from '../utils/session-context'

function getSafeRequestError(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid chat request'
}

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8')

  let request
  try {
    if (rawBody === undefined) {
      throw new Error('request body must be valid JSON')
    }
    request = await parseChatPayload(rawBody)
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: getSafeRequestError(error),
    })
  }

  let chatConfig: ReturnType<typeof resolveChatConfig>
  try {
    chatConfig = resolveChatConfig(useRuntimeConfig(event) as ChatRuntimeConfig, request.model)
  } catch {
    throw createError({
      statusCode: 500,
      statusMessage: 'LLM server configuration is incomplete.',
    })
  }

  const provider = createOpenAI({
    baseURL: chatConfig.baseURL,
    apiKey: chatConfig.apiKey,
  })
  const sessions = createSessionRepository(getChatDatabase())
  const session = await sessions.getSession(request.sessionId)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }
  const history = await buildSessionContext(request.sessionId, sessions)
  const messages = request.kind === 'message' ? [...history, request.message] : history
  const runId = session.runLogId
  const abortSignal = event.web?.request?.signal

  try {
    return await streamChatAgent({
      model: provider.chat(chatConfig.modelId),
      modelId: chatConfig.modelId,
      messages,
      abortSignal,
      runId,
      logLevel: chatConfig.logLevel,
    })
  } catch (error) {
    console.error('[chat] provider stream failed')
    throw createError({
      statusCode: 502,
      statusMessage: 'Не удалось получить ответ модели. Проверьте настройки сервера и повторите запрос.',
      cause: error,
    })
  }
})
