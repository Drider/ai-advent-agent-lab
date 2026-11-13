import type { UIMessage } from 'ai'
import type { ChatCompactionSettings } from '../../shared/chat'
import type { CompactionTrigger, ContextCheckpoint, StoredContextMessage } from './types'
import { estimateInputTokens, estimateMessageCharacters } from './estimate'

export const COMPACTION_TAIL_MESSAGES = 10
export const COMPACTION_TRIGGER_FRACTION = 0.7
export const COMPACTION_HARD_FRACTION = 0.8
export const COMPACTION_FALLBACK_CHARACTERS = 120_000
export const COMPACTION_SUMMARY_RESERVE_TOKENS = 1_000

export type ContextDecision =
  | {
      kind: 'pass'
      estimatedBeforeTokens: number
      estimatedAfterTokens: number
    }
  | {
      kind: 'compact'
      trigger: CompactionTrigger
      toSummarize: StoredContextMessage[]
      tail: StoredContextMessage[]
      fromMessagePosition: number
      throughMessagePosition: number
      estimatedBeforeTokens: number
      estimatedAfterTokens: number
    }
  | {
      kind: 'overflow'
      reason: 'context_budget' | 'tail_budget' | 'no_safe_prefix'
      estimatedBeforeTokens: number
      estimatedAfterTokens: number
    }

function asModelMessages(messages: StoredContextMessage[]): UIMessage[] {
  return messages.map(item => item.message)
}

function summaryMessage(summary: string | undefined): UIMessage[] {
  return summary === undefined
    ? []
    : [{ id: 'context-summary', role: 'user', parts: [{ type: 'text', text: `[Historical conversation summary]\n${summary}` }] }]
}

function hardBudgetExceeded(
  messages: StoredContextMessage[],
  summary: string | undefined,
  settings: ChatCompactionSettings,
  promptOverheadTokens: number,
): boolean {
  const modelMessages = [...summaryMessage(summary), ...asModelMessages(messages)]
  if (settings.contextWindowTokens !== undefined) {
    return estimateInputTokens(modelMessages, promptOverheadTokens) > settings.contextWindowTokens * COMPACTION_HARD_FRACTION
  }
  return estimateMessageCharacters(modelMessages) > COMPACTION_FALLBACK_CHARACTERS
}

function chooseTail(messages: StoredContextMessage[]): { toSummarize: StoredContextMessage[]; tail: StoredContextMessage[] } | null {
  if (messages.length <= COMPACTION_TAIL_MESSAGES) return null

  let tailStart = messages.length - COMPACTION_TAIL_MESSAGES
  const firstIncomplete = messages.slice(0, tailStart).findIndex(item => item.status !== 'complete')
  if (firstIncomplete >= 0) tailStart = firstIncomplete
  while (tailStart > 0 && messages[tailStart]?.message.role !== 'user') tailStart -= 1

  const toSummarize = messages.slice(0, tailStart)
  if (toSummarize.length === 0 || toSummarize.some(item => item.status !== 'complete')) return null
  return { toSummarize, tail: messages.slice(tailStart) }
}

export function decideCompaction(input: {
  messages: StoredContextMessage[]
  checkpoint: ContextCheckpoint | null
  settings: ChatCompactionSettings
  promptOverheadTokens: number
}): ContextDecision {
  const afterPosition = input.checkpoint?.throughMessagePosition ?? -1
  const unsummarized = input.messages.filter(item => item.position > afterPosition)
  const existingSummary = input.checkpoint?.summary
  const modelMessages = [...summaryMessage(existingSummary), ...asModelMessages(unsummarized)]
  const estimatedBeforeTokens = estimateInputTokens(modelMessages, input.promptOverheadTokens)
  const estimatedBeforeCharacters = estimateMessageCharacters(modelMessages)
  const windowTrigger = input.settings.contextWindowTokens !== undefined
    && estimatedBeforeTokens >= input.settings.contextWindowTokens * COMPACTION_TRIGGER_FRACTION
  const messageTrigger = unsummarized.length >= input.settings.messageThreshold
  const fallbackTrigger = input.settings.contextWindowTokens === undefined
    && estimatedBeforeCharacters >= COMPACTION_FALLBACK_CHARACTERS
  const hardOverflow = hardBudgetExceeded(unsummarized, existingSummary, input.settings, input.promptOverheadTokens)

  if (!input.settings.enabled) {
    return hardOverflow
      ? { kind: 'overflow', reason: 'context_budget', estimatedBeforeTokens, estimatedAfterTokens: estimatedBeforeTokens }
      : { kind: 'pass', estimatedBeforeTokens, estimatedAfterTokens: estimatedBeforeTokens }
  }

  if (!windowTrigger && !messageTrigger && !fallbackTrigger) {
    return { kind: 'pass', estimatedBeforeTokens, estimatedAfterTokens: estimatedBeforeTokens }
  }

  const selected = chooseTail(unsummarized)
  if (!selected) {
    return hardOverflow
      ? { kind: 'overflow', reason: 'no_safe_prefix', estimatedBeforeTokens, estimatedAfterTokens: estimatedBeforeTokens }
      : { kind: 'pass', estimatedBeforeTokens, estimatedAfterTokens: estimatedBeforeTokens }
  }

  const compactedMessages = [...summaryMessage('summary placeholder'), ...asModelMessages(selected.tail)]
  const estimatedAfterTokens = estimateInputTokens(compactedMessages, input.promptOverheadTokens)
  const estimatedAfterCharacters = estimateMessageCharacters(compactedMessages)
  const tailOverflow = input.settings.contextWindowTokens !== undefined
    ? estimatedAfterTokens > input.settings.contextWindowTokens * COMPACTION_HARD_FRACTION
    : estimatedAfterCharacters > COMPACTION_FALLBACK_CHARACTERS
  if (tailOverflow) {
    return { kind: 'overflow', reason: 'tail_budget', estimatedBeforeTokens, estimatedAfterTokens }
  }

  const trigger: CompactionTrigger = windowTrigger
    ? 'context_fraction'
    : messageTrigger
      ? 'message_count'
      : 'fallback_limit'
  return {
    kind: 'compact',
    trigger,
    toSummarize: selected.toSummarize,
    tail: selected.tail,
    fromMessagePosition: selected.toSummarize[0]!.position,
    throughMessagePosition: selected.toSummarize.at(-1)!.position,
    estimatedBeforeTokens,
    estimatedAfterTokens,
  }
}
