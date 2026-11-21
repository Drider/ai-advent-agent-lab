import { randomInt } from 'node:crypto'
import { createOpenAI } from '@ai-sdk/openai'
import { createError, defineEventHandler, readRawBody } from 'h3'
import type { ChatRuntimeConfig } from '../utils/chat-request'
import { parseChatPayload, resolveChatConfig } from '../utils/chat-request'
import { getAgentConfig, streamChatAgent } from '../agent/chat-agent'
import { createDiceTool, createListSavedRollsTool } from '../tools/dice'
import { createSaveMemoryTool } from '../tools/memory'
import { createModelConfigurationTools } from '../tools/model-configurations'
import { createUserProfileTools } from '../tools/user-profiles'
import { createTaskTools } from '../tools/tasks'
import { getChatDatabase } from '../persistence/db'
import { createDiceRollRepository } from '../persistence/dice-roll-repository'
import { createSessionRepository } from '../persistence/session-repository'
import { createTurnRepository, TurnRepositoryError } from '../persistence/turn-repository'
import { prepareSessionContext } from '../context-compaction/prepare'
import { classifyAgentStopReason } from '../utils/agent-stop-reason'
import type { ChatUIMessage } from '../../shared/chat'
import { startMemoryAwareTurn } from '../memory/start-turn'
import { toMemoryHttpError } from '../memory/api-errors'
import type { MemorySnapshot } from '../../shared/memory'
import { estimateInputTokens } from '../context-compaction/estimate'
import { createMemoryUsageRepository } from '../memory/usage-repository'
import { ContextLimitError } from '../context-compaction/step-guard'
import { createInvariantRepository } from '../persistence/invariant-repository'

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
  const invariants = createInvariantRepository(db).list()
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
  const contextStrategy = request.contextStrategy ?? session.contextStrategy
  const legacyCompaction = request.compaction ?? { enabled: true, messageThreshold: contextStrategy.messageThreshold }
  const compactionSettings = {
    ...legacyCompaction,
    enabled: contextStrategy.strategy === 'summary' && legacyCompaction.enabled,
    messageThreshold: contextStrategy.messageThreshold,
  }
  const model = provider.chat(chatConfig.modelId)
  let turnId: string
  let memorySnapshot: MemorySnapshot
  let profileSnapshot
  let taskSnapshot
  let agentConfig: Record<string, unknown>
  try {
    const started = startMemoryAwareTurn(db, {
      request,
      modelId: chatConfig.modelId,
      agentConfig: getAgentConfig(compactionSettings, contextStrategy, undefined, request.kind === 'continue', undefined, invariants),
      createAgentConfig: (profile, task) => getAgentConfig(compactionSettings, contextStrategy, profile, request.kind === 'continue', task, invariants),
    })
    turnId = started.turnId
    memorySnapshot = started.snapshot
    profileSnapshot = started.profileSnapshot
    taskSnapshot = started.taskSnapshot
    agentConfig = started.agentConfig
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
    if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'MEMORY_BUDGET_EXCEEDED') {
      throw toMemoryHttpError(error)
    }
    if (error instanceof ContextLimitError) {
      throw createError({ statusCode: 422, statusMessage: error.message })
    }
    throw error
  }

  let preparedContext
  let promptOverheadTokens = 2_000
  try {
    const instructions = agentConfig.instructions
    promptOverheadTokens = typeof instructions === 'string'
      ? Math.ceil(Buffer.byteLength(instructions, 'utf8') / 2) + 2_000
      : 2_000
    preparedContext = await prepareSessionContext({
      db,
      sessionId: request.sessionId,
      turnId,
      model,
      modelId: chatConfig.modelId,
      settings: compactionSettings,
      contextStrategy,
      memorySnapshot,
      pricing: request.pricing,
      promptOverheadTokens,
      abortSignal: event.web?.request?.signal,
    })
  } catch (error) {
    turns.markFailed(turnId, classifyAgentStopReason(error))
    if (error instanceof ContextLimitError) {
      throw createError({ statusCode: 422, statusMessage: error.message })
    }
    throw error
  }

  try {
    const memoryIds = new Set(memorySnapshot.messages.map(message => message.id))
    const shortTermMessages = preparedContext.modelMessages.filter(message => !memoryIds.has(message.id))
    const shortTermBytes = shortTermMessages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify({ role: message.role, parts: message.parts }), 'utf8'), 0)
    createMemoryUsageRepository(db).recordPrepared({
      turnId,
      snapshot: memorySnapshot,
      requireTurn: true,
      shortTerm: {
        count: shortTermMessages.length,
        bytes: shortTermBytes,
        estimatedTokens: estimateInputTokens(shortTermMessages, 0),
      },
    })
  } catch (error) {
    console.error('[chat] failed to record memory usage', error)
  }

  const diceRepository = createDiceRollRepository(db)
  // Read the log id after the turn is reserved. A concurrent history clear
  // cannot rotate it while the running turn blocks that operation.
  const runId = (db.prepare('SELECT run_log_id FROM sessions WHERE id = ?').get(request.sessionId) as { run_log_id: string }).run_log_id
  const abortSignal = event.web?.request?.signal

  try {
    return await streamChatAgent({
      model,
      modelId: chatConfig.modelId,
      messages: preparedContext.modelMessages,
      originalMessages: preparedContext.originalMessages,
      contextWindowTokens: compactionSettings.contextWindowTokens,
      promptOverheadTokens,
      abortSignal,
      runId,
      logLevel: chatConfig.logLevel,
      sensitiveValues: [chatConfig.apiKey],
      pricing: request.pricing,
      sessionId: request.sessionId,
      turnId,
      memoryMetadata: memorySnapshot.transientMemory,
      profileSnapshot,
      turnRepository: turns,
      disableMutatingTools: request.kind === 'continue',
      saveMemoryTool: createSaveMemoryTool({ db, sessionId: request.sessionId, projectId: session.projectId }),
      modelConfigurationTools: createModelConfigurationTools({ db }),
      userProfileTools: createUserProfileTools({ db, sessionId: request.sessionId, turnId }),
      task: taskSnapshot,
      taskTools: createTaskTools({ db, sessionId: request.sessionId, turnId }),
      invariants,
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
