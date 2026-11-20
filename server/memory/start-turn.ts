import type Database from 'better-sqlite3'
import { COMPACTION_FALLBACK_CHARACTERS } from '../context-compaction/policy'
import { estimateMessageCharacters, estimateInputTokens } from '../context-compaction/estimate'
import { ContextLimitError } from '../context-compaction/step-guard'
import { createTurnRepository, TurnRepositoryError } from '../persistence/turn-repository'
import type { ChatRequestBody, ChatUIMessage } from '../../shared/chat'
import { assertMemoryBudgets, createMemorySnapshot } from './context'
import { assertHistoryAvailable } from './clear-repository'
import type { MemorySnapshot } from '../../shared/memory'
import { createUserProfileRepository } from '../persistence/user-profile-repository'
import type { UserProfileSnapshot } from '../../shared/user-profile'

function promptOverhead(agentConfig: Record<string, unknown>): number {
  const instructions = agentConfig.instructions
  return typeof instructions === 'string' ? Math.ceil(Buffer.byteLength(instructions, 'utf8') / 2) + 2_000 : 2_000
}

function assertImmediateMemoryWindow(snapshot: MemorySnapshot, request: ChatRequestBody, agentConfig: Record<string, unknown>): void {
  const compaction = agentConfig.contextCompaction
  const window = compaction && typeof compaction === 'object' && 'contextWindowTokens' in compaction
    && typeof compaction.contextWindowTokens === 'number' ? compaction.contextWindowTokens : undefined
  const messages = [...snapshot.messages, request.message]
  const estimated = estimateInputTokens(messages, promptOverhead(agentConfig))
  const tooLarge = window === undefined
    ? estimateMessageCharacters(messages) + promptOverhead(agentConfig) * 2 > COMPACTION_FALLBACK_CHARACTERS
    : estimated > window * 0.8
  if (tooLarge) throw new ContextLimitError(estimated, window)
}

export function startMemoryAwareTurn(db: Database.Database, input: {
  request: ChatRequestBody
  modelId: string
  agentConfig: Record<string, unknown>
  createAgentConfig?: (profileSnapshot: UserProfileSnapshot) => Record<string, unknown>
}): { turnId: string; snapshot: MemorySnapshot; profileSnapshot: UserProfileSnapshot; agentConfig: Record<string, unknown> } {
  const transaction = db.transaction(() => {
    assertHistoryAvailable(db, input.request.sessionId)
    const profileSnapshot = createUserProfileRepository(db).getForTurn(input.request.sessionId)
    const agentConfig = input.createAgentConfig?.(profileSnapshot) ?? input.agentConfig
    const snapshot = createMemorySnapshot(db, input.request.sessionId, input.request.message)
    assertMemoryBudgets(snapshot)
    assertImmediateMemoryWindow(snapshot, input.request, agentConfig)
    const turns = createTurnRepository(db)
    if (input.request.kind === 'message') {
      const started = turns.beginUserTurn({
        sessionId: input.request.sessionId,
        requestId: input.request.requestId,
        modelId: input.modelId,
        message: input.request.message as ChatUIMessage,
        agentConfig,
      })
      return { turnId: started.turnId, snapshot, profileSnapshot, agentConfig }
    }
    const continuation = turns.assessContinuation(input.request.sourceTurnId)
    if (continuation === 'not_available') throw new TurnRepositoryError('CONTINUATION_NOT_AVAILABLE', `turn ${input.request.sourceTurnId} is not available for continuation`)
    if (continuation === 'needs_review') throw new TurnRepositoryError('CONTINUATION_NEEDS_REVIEW', `turn ${input.request.sourceTurnId} has an unconfirmed tool result`)
    const started = turns.beginContinuation({
      sessionId: input.request.sessionId,
      requestId: input.request.requestId,
      sourceTurnId: input.request.sourceTurnId,
      modelId: input.modelId,
      message: input.request.message as ChatUIMessage,
      agentConfig,
    })
    return { turnId: started.turnId, snapshot, profileSnapshot, agentConfig }
  })
  return transaction.immediate()
}

