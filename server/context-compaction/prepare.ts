import type Database from 'better-sqlite3'
import { validateUIMessages, type LanguageModel, type UIMessage } from 'ai'
import { calculateChatCost, type ChatCompactionSettings, type ChatPricing, type ChatUIMessage } from '../../shared/chat'
import { createCompactionRepository } from './repository'
import { decideCompaction, type ContextDecision } from './policy'
import { getCompactionErrorUsage, summarizeOldContext } from './summarizer'
import { ContextLimitError } from './step-guard'
import type { CompactionAttempt, ContextCheckpoint, StoredContextMessage } from './types'

function historicalSummaryMessage(checkpoint: ContextCheckpoint): UIMessage {
  return {
    id: `context-summary-${checkpoint.id}`,
    role: 'user',
    parts: [{ type: 'text', text: `[Historical conversation summary]\n${checkpoint.summary}` }],
  }
}

function stripTrailingInterruptedAssistant(messages: StoredContextMessage[]): StoredContextMessage[] {
  const result = messages.map(item => ({ ...item, message: { ...item.message, parts: [...item.message.parts] } }))
  const last = result.at(-1)
  if (!last || last.message.role !== 'assistant' || (last.status !== 'interrupted' && last.status !== 'partial')) return result

  const confirmedParts = last.message.parts.filter(part => part.type !== 'text' && part.type !== 'reasoning' && part.type !== 'step-start')
  if (confirmedParts.length === 0) {
    result.pop()
  } else {
    last.message = { ...last.message, parts: confirmedParts }
  }
  return result
}

function modelMessagesFor(
  checkpoint: ContextCheckpoint | null,
  messages: StoredContextMessage[],
): UIMessage[] {
  return [
    ...(checkpoint ? [historicalSummaryMessage(checkpoint)] : []),
    ...messages.map(item => item.message),
  ]
}

function findAttempt(repository: ReturnType<typeof createCompactionRepository>, sessionId: string, attemptId: string): CompactionAttempt | undefined {
  return repository.listAttempts(sessionId).find(attempt => attempt.id === attemptId)
}

export async function prepareSessionContext(input: {
  db: Database.Database
  sessionId: string
  turnId: string
  model: LanguageModel
  modelId: string
  settings: ChatCompactionSettings
  pricing?: ChatPricing
  promptOverheadTokens: number
  abortSignal?: AbortSignal
}): Promise<{
  modelMessages: UIMessage[]
  originalMessages: UIMessage[]
  attempt?: CompactionAttempt
}> {
  const repository = createCompactionRepository(input.db)
  const storedMessages = stripTrailingInterruptedAssistant(await repository.loadMessages(input.sessionId))
  const checkpoint = repository.latestCheckpoint(input.sessionId)
  const decision = decideCompaction({
    messages: storedMessages,
    checkpoint,
    settings: input.settings,
    promptOverheadTokens: input.promptOverheadTokens,
  })
  const originalMessages = storedMessages.map(item => item.message)

  if (decision.kind === 'overflow') {
    throw new ContextLimitError(decision.estimatedBeforeTokens, input.settings.contextWindowTokens)
  }
  if (decision.kind === 'pass') {
    const modelMessages = modelMessagesFor(checkpoint, storedMessages.filter(item => checkpoint === null || item.position > checkpoint.throughMessagePosition))
    return { modelMessages: await validateUIMessages({ messages: modelMessages }), originalMessages }
  }

  const attemptId = repository.beginAttempt({
    sessionId: input.sessionId,
    turnId: input.turnId,
    trigger: decision.trigger,
    modelId: input.modelId,
    fromMessagePosition: decision.fromMessagePosition,
    throughMessagePosition: decision.throughMessagePosition,
    estimatedBeforeTokens: decision.estimatedBeforeTokens,
    estimatedAfterTokens: decision.estimatedAfterTokens,
  })

  try {
    const summary = await summarizeOldContext({
      model: input.model,
      previousSummary: checkpoint?.summary,
      messages: decision.toSummarize,
      abortSignal: input.abortSignal,
    })
    const checkpointResult = repository.finishAttempt({
      attemptId,
      status: 'completed',
      summary: summary.text,
      usage: summary.usage,
      costRub: summary.usage === undefined ? undefined : calculateChatCost(summary.usage, input.pricing),
    })
    if (!checkpointResult) throw new Error('compaction did not create a checkpoint')
    const modelMessages = modelMessagesFor(checkpointResult, decision.tail)
    return {
      modelMessages: await validateUIMessages({ messages: modelMessages }),
      originalMessages,
      attempt: findAttempt(repository, input.sessionId, attemptId),
    }
  } catch (error) {
    try {
      const usage = getCompactionErrorUsage(error)
      repository.finishAttempt({
        attemptId,
        status: 'failed',
        usage,
        costRub: usage === undefined ? undefined : calculateChatCost(usage, input.pricing),
        error: error instanceof Error ? error.message : 'compaction failed',
      })
    } catch {
      // Preserve the original summarizer failure if persistence also fails.
    }
    throw error
  }
}

export type ContextPreparationDecision = ContextDecision
export type { ChatUIMessage }
