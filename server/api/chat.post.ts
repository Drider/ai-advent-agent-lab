import { randomInt } from 'node:crypto'
import { createOpenAI } from '@ai-sdk/openai'
import { createError, defineEventHandler, readRawBody } from 'h3'
import type { ChatRuntimeConfig } from '../utils/chat-request'
import { parseChatPayload, resolveChatConfig } from '../utils/chat-request'
import { getAgentConfig, streamChatAgent } from '../agent/chat-agent'
import { createDiceTool, createListSavedRollsTool } from '../tools/dice'
import { getChatDatabase } from '../persistence/db'
import { createDiceRollRepository } from '../persistence/dice-roll-repository'
import { createSessionRepository } from '../persistence/session-repository'
import { createTurnRepository, TurnRepositoryError } from '../persistence/turn-repository'
import { buildSessionContext, SessionContextError } from '../utils/session-context'
import type { ChatUIMessage } from '../../shared/chat'

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

  const db = getChatDatabase()
  const provider = createOpenAI({
    baseURL: chatConfig.baseURL,
    apiKey: chatConfig.apiKey,
  })
  const turns = createTurnRepository(db)
  const sessions = createSessionRepository(getChatDatabase())
  const session = await sessions.getSession(request.sessionId)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'Session not found' })
  }
  let turnId: string
  try {
    if (request.kind === 'message') {
      turnId = turns.beginUserTurn({
        sessionId: request.sessionId,
        requestId: request.requestId,
        modelId: chatConfig.modelId,
        message: request.message as ChatUIMessage,
        agentConfig: getAgentConfig(),
      }).turnId
    } else {
      const continuation = turns.assessContinuation(request.sourceTurnId)
      if (continuation === 'not_available') {
        throw new TurnRepositoryError('CONTINUATION_NOT_AVAILABLE', `turn ${request.sourceTurnId} is not available for continuation`)
      }
      if (continuation === 'needs_review') {
        throw new TurnRepositoryError('CONTINUATION_NEEDS_REVIEW', `turn ${request.sourceTurnId} has an unconfirmed tool result`)
      }
      turnId = turns.beginContinuation({
        sessionId: request.sessionId,
        requestId: request.requestId,
        sourceTurnId: request.sourceTurnId,
        modelId: chatConfig.modelId,
        message: request.message as ChatUIMessage,
        agentConfig: getAgentConfig(),
      }).turnId
    }
  } catch (error) {
    if (error instanceof TurnRepositoryError && error.code === 'TURN_ALREADY_EXISTS') {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    if (error instanceof TurnRepositoryError && error.code === 'TURN_NOT_FOUND') {
      throw createError({ statusCode: 404, statusMessage: error.message })
    }
    if (error instanceof TurnRepositoryError && error.code === 'CONTINUATION_NOT_AVAILABLE') {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    if (error instanceof TurnRepositoryError && error.code === 'CONTINUATION_NEEDS_REVIEW') {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    throw error
  }

  let messages
  try {
    messages = await buildSessionContext(request.sessionId, sessions)
  } catch (error) {
    turns.markFailed(turnId)
    if (error instanceof SessionContextError && error.code === 'SESSION_NOT_FOUND') {
      throw createError({ statusCode: 404, statusMessage: error.message })
    }
    throw error
  }

  const diceRepository = createDiceRollRepository(db)
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
      sensitiveValues: [chatConfig.apiKey],
      pricing: request.pricing,
      sessionId: request.sessionId,
      turnId,
      turnRepository: turns,
      disableMutatingTools: request.kind === 'continue',
    },
    createDiceTool(randomInt, { repository: diceRepository }),
    createListSavedRollsTool({ repository: diceRepository }),
    )
  } catch (error) {
    console.error('[chat] provider stream failed')
    throw createError({
      statusCode: 502,
      statusMessage: 'Не удалось получить ответ модели. Проверьте настройки сервера и повторите запрос.',
      cause: error,
    })
  }
})
