import type { LanguageModelUsage } from 'ai'
import type { ChatTokenUsage } from '../../shared/chat'

type StepWithUsage = { usage?: LanguageModelUsage }

function reportedTokenCount(raw: LanguageModelUsage['raw'], group: string, field: string): number | undefined {
  const details = raw?.[group]
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined
  const count = (details as Record<string, unknown>)[field]
  return typeof count === 'number' ? count : undefined
}

function getTokenUsage(usage: LanguageModelUsage | undefined): LanguageModelUsage {
  const raw = usage?.raw
  // The OpenAI adapter fills missing cache/reasoning fields with zero.
  const hasOpenAIUsage = raw != null && ('prompt_tokens' in raw || 'completion_tokens' in raw)
  const cacheRead = reportedTokenCount(raw, 'prompt_tokens_details', 'cached_tokens')
  const cacheWrite = reportedTokenCount(raw, 'prompt_tokens_details', 'cache_write_tokens')
  const reasoning = reportedTokenCount(raw, 'completion_tokens_details', 'reasoning_tokens')
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    inputTokenDetails: {
      noCacheTokens: hasOpenAIUsage && cacheRead === undefined ? undefined : usage?.inputTokenDetails.noCacheTokens,
      cacheReadTokens: hasOpenAIUsage ? cacheRead : usage?.inputTokenDetails.cacheReadTokens,
      cacheWriteTokens: hasOpenAIUsage ? cacheWrite : usage?.inputTokenDetails.cacheWriteTokens,
    },
    outputTokenDetails: {
      textTokens: hasOpenAIUsage && reasoning === undefined ? undefined : usage?.outputTokenDetails.textTokens,
      reasoningTokens: hasOpenAIUsage ? reasoning : usage?.outputTokenDetails.reasoningTokens,
    },
  }
}

export function sumUsage(steps: StepWithUsage[]): LanguageModelUsage | undefined {
  if (steps.length === 0) {
    return undefined
  }

  const usages = steps.map(step => getTokenUsage(step.usage))
  const sum = (selector: (usage: LanguageModelUsage) => number | undefined) => {
    const counts = usages.map(selector)
    return counts.some(count => count === undefined)
      ? undefined
      : counts.reduce<number>((total, count) => total + (count ?? 0), 0)
  }

  return {
    inputTokens: sum(usage => usage.inputTokens),
    inputTokenDetails: {
      noCacheTokens: sum(usage => usage.inputTokenDetails.noCacheTokens),
      cacheReadTokens: sum(usage => usage.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: sum(usage => usage.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: sum(usage => usage.outputTokens),
    outputTokenDetails: {
      textTokens: sum(usage => usage.outputTokenDetails.textTokens),
      reasoningTokens: sum(usage => usage.outputTokenDetails.reasoningTokens),
    },
    totalTokens: sum(usage => usage.totalTokens),
  }
}

export function summarizeTokenUsage(steps: StepWithUsage[], totalUsage: LanguageModelUsage | undefined): {
  usage: ChatTokenUsage
  steps: Array<{ usage: LanguageModelUsage }>
} {
  const details = sumUsage(steps)
  return {
    usage: {
      ...getTokenUsage(totalUsage),
      inputTokenDetails: details?.inputTokenDetails,
      outputTokenDetails: details?.outputTokenDetails,
    },
    steps: steps.map(step => ({ usage: getTokenUsage(step.usage) })),
  }
}
