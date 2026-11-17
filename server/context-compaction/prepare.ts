import type Database from 'better-sqlite3'
import { validateUIMessages, type LanguageModel, type ModelMessage, type UIMessage } from 'ai'
import { calculateChatCost, type ChatCompactionSettings, type ChatContextStrategySettings, type ChatPricing, type ChatUIMessage } from '../../shared/chat'
import { createCompactionRepository } from './repository'
import { createFactsRepository, type StickyFacts } from './facts-repository'
import { updateFacts } from './facts'
import { decideCompaction, type ContextDecision } from './policy'
import { getCompactionErrorUsage, summarizeOldContext } from './summarizer'
import { assertStepWithinBudget, ContextLimitError } from './step-guard'
import { selectSlidingWindow } from './sliding-window'
import type { CompactionAttempt, ContextCheckpoint, StoredContextMessage } from './types'
import { estimateInputTokens } from './estimate'
import type { MemorySnapshot } from '../../shared/memory'

function memoryOverheadTokens(snapshot: MemorySnapshot | undefined): number {
  return snapshot === undefined ? 0 : estimateInputTokens(snapshot.messages, 0)
}

function withMemory(snapshot: MemorySnapshot | undefined, messages: UIMessage[]): UIMessage[] {
  return snapshot === undefined ? messages : [...snapshot.messages, ...messages]
}

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

function stickyFactsMessage(facts: StickyFacts, throughPosition: number): UIMessage | undefined {
  if (Object.keys(facts).length === 0) return undefined
  return {
    id: `sticky-facts-${throughPosition}`,
    role: 'user',
    parts: [{ type: 'text', text: `[Sticky facts]\n${JSON.stringify(facts)}` }],
  }
}

function findAttempt(repository: ReturnType<typeof createCompactionRepository>, sessionId: string, attemptId: string): CompactionAttempt | undefined {
  return repository.listAttempts(sessionId).find(attempt => attempt.id === attemptId)
}

function sourceMessageStillExists(db: Database.Database, sessionId: string, messageId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND id = ?').get(sessionId, messageId))
}

export async function prepareSessionContext(input: {
  db: Database.Database
  sessionId: string
  turnId: string
  model: LanguageModel
  modelId: string
  settings: ChatCompactionSettings
  contextStrategy?: ChatContextStrategySettings
  memorySnapshot?: MemorySnapshot
  pricing?: ChatPricing
  promptOverheadTokens: number
  abortSignal?: AbortSignal
}): Promise<{
  modelMessages: UIMessage[]
  originalMessages: UIMessage[]
  attempt?: CompactionAttempt
}> {
  const repository = createCompactionRepository(input.db)
  const factsRepository = createFactsRepository(input.db)
  const storedMessages = stripTrailingInterruptedAssistant(await repository.loadMessages(input.sessionId))
  const checkpoint = repository.latestCheckpoint(input.sessionId)
  const originalMessages = storedMessages.map(item => item.message)
  const strategy = input.contextStrategy?.strategy ?? (input.settings.enabled ? 'summary' : 'off')
  const contextPromptOverheadTokens = input.promptOverheadTokens + memoryOverheadTokens(input.memorySnapshot)

  if (strategy === 'off' || strategy === 'sliding_window') {
    const selected = strategy === 'sliding_window'
      ? selectSlidingWindow(storedMessages, input.contextStrategy?.windowSize ?? 10)
      : storedMessages
    const modelMessages = await validateUIMessages({ messages: withMemory(input.memorySnapshot, selected.map(item => item.message)) })
    assertStepWithinBudget({
      messages: modelMessages as unknown as ModelMessage[],
      contextWindowTokens: input.settings.contextWindowTokens,
      promptOverheadTokens: input.promptOverheadTokens,
    })
    return { modelMessages, originalMessages }
  }

  if (strategy === 'sticky_facts') {
    let facts = factsRepository.latestFacts(input.sessionId)
    for (const stored of storedMessages) {
      if (stored.message.role !== 'user' || stored.status !== 'complete') continue
      const previous = factsRepository.existing(input.sessionId, stored.message.id)
      if (previous?.status === 'completed') {
        facts = previous.facts
        continue
      }
      try {
        const update = await updateFacts({
          model: input.model,
          previousFacts: facts,
          userMessage: stored.message,
          abortSignal: input.abortSignal,
        })
        // History may be cleared while the maintenance model is running. Do
        // not resurrect a deleted source message or its extracted facts.
        if (!sourceMessageStillExists(input.db, input.sessionId, stored.message.id)) {
          throw new Error('conversation history was cleared while updating Sticky Facts')
        }
        const saved = factsRepository.saveFactsUpdate({
          sessionId: input.sessionId,
          sourceMessageId: stored.message.id,
          throughMessagePosition: stored.position,
          facts: update.facts,
          usage: update.usage,
          costRub: update.usage === undefined ? undefined : calculateChatCost(update.usage, input.pricing),
        })
        facts = saved.facts
      } catch (error) {
        if (sourceMessageStillExists(input.db, input.sessionId, stored.message.id)) {
          factsRepository.saveFactsUpdate({
            sessionId: input.sessionId,
            sourceMessageId: stored.message.id,
            throughMessagePosition: stored.position,
            facts,
            status: 'failed',
            error: error instanceof Error ? error.message : 'facts update failed',
          })
        }
        throw error
      }
    }
    const tail = selectSlidingWindow(storedMessages, input.contextStrategy?.windowSize ?? 10)
    const factsMessage = stickyFactsMessage(facts, tail.at(-1)?.position ?? -1)
    const modelMessages = await validateUIMessages({ messages: withMemory(
      input.memorySnapshot,
      factsMessage === undefined ? tail.map(item => item.message) : [factsMessage, ...tail.map(item => item.message)],
    ) })
    assertStepWithinBudget({
      messages: modelMessages as unknown as ModelMessage[],
      contextWindowTokens: input.settings.contextWindowTokens,
      promptOverheadTokens: input.promptOverheadTokens,
    })
    return { modelMessages, originalMessages }
  }

  const decision = decideCompaction({
    messages: storedMessages,
    checkpoint,
    settings: input.settings,
    promptOverheadTokens: contextPromptOverheadTokens,
  })
  if (decision.kind === 'overflow') {
    throw new ContextLimitError(decision.estimatedBeforeTokens, input.settings.contextWindowTokens)
  }
  if (decision.kind === 'pass') {
    const modelMessages = withMemory(input.memorySnapshot, modelMessagesFor(checkpoint, storedMessages.filter(item => checkpoint === null || item.position > checkpoint.throughMessagePosition)))
    const validatedMessages = await validateUIMessages({ messages: modelMessages })
    assertStepWithinBudget({
      messages: validatedMessages as unknown as ModelMessage[],
      contextWindowTokens: input.settings.contextWindowTokens,
      promptOverheadTokens: input.promptOverheadTokens,
    })
    return { modelMessages: validatedMessages, originalMessages }
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
    const modelMessages = withMemory(input.memorySnapshot, modelMessagesFor(checkpointResult, decision.tail))
    const validatedMessages = await validateUIMessages({ messages: modelMessages })
    assertStepWithinBudget({
      messages: validatedMessages as unknown as ModelMessage[],
      contextWindowTokens: input.settings.contextWindowTokens,
      promptOverheadTokens: input.promptOverheadTokens,
    })
    return {
      modelMessages: validatedMessages,
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
