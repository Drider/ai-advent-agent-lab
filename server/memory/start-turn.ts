import type Database from 'better-sqlite3'
import { estimateInputTokens } from '../context-compaction/estimate'
import { ContextLimitError } from '../context-compaction/step-guard'
import { createTurnRepository, TurnRepositoryError } from '../persistence/turn-repository'
import type { ChatRequestBody, ChatUIMessage } from '../../shared/chat'
import { assertMemoryBudgets, createMemorySnapshot } from './context'
import { assertHistoryAvailable } from './clear-repository'
import type { MemorySnapshot } from '../../shared/memory'

function promptOverhead(agentConfig: Record<string, unknown>): number {
  const instructions = agentConfig.instructions
  return typeof instructions === 'string' ? Math.ceil(Buffer.byteLength(instructions, 'utf8') / 2) + 2_000 : 2_000
}

function assertImmediateMemoryWindow(snapshot: MemorySnapshot, request: ChatRequestBody, agentConfig: Record<string, unknown>): void {
  const compaction = agentConfig.contextCompaction
  if (!compaction || typeof compaction !== 'object' || !('contextWindowTokens' in compaction) || typeof compaction.contextWindowTokens !== 'number') return
  const messages = [...snapshot.messages, request.message]
  const estimated = estimateInputTokens(messages, promptOverhead(agentConfig))
  if (estimated > compaction.contextWindowTokens * 0.8) throw new ContextLimitError(estimated, compaction.contextWindowTokens)
}

export function startMemoryAwareTurn(db: Database.Database, input: {
  request: ChatRequestBody
  modelId: string
  agentConfig: Record<string, unknown>
}): { turnId: string; snapshot: MemorySnapshot } {
  assertHistoryAvailable(db, input.request.sessionId)
  const snapshot = createMemorySnapshot(db, input.request.sessionId, input.request.message)
  assertMemoryBudgets(snapshot)
  assertImmediateMemoryWindow(snapshot, input.request, input.agentConfig)
  const turns = createTurnRepository(db)
  if (input.request.kind === 'message') {
    const started = turns.beginUserTurn({
      sessionId: input.request.sessionId,
      requestId: input.request.requestId,
      modelId: input.modelId,
      message: input.request.message as ChatUIMessage,
      agentConfig: input.agentConfig,
    })
    return { turnId: started.turnId, snapshot }
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
    agentConfig: input.agentConfig,
  })
  return { turnId: started.turnId, snapshot }
}

