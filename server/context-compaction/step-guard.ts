import type { ModelMessage } from 'ai'
import { COMPACTION_HARD_FRACTION, COMPACTION_FALLBACK_CHARACTERS } from './policy'

export class ContextLimitError extends Error {
  readonly code = 'context_length_exceeded'

  constructor(
    public readonly estimatedInputTokens: number,
    public readonly contextWindowTokens: number | undefined,
  ) {
    super('context window budget exceeded before the next model step')
    this.name = 'ContextLimitError'
  }
}

function serializedSize(messages: ModelMessage[]): { characters: number; bytes: number } {
  const serialized = JSON.stringify(messages)
  return { characters: serialized.length, bytes: Buffer.byteLength(serialized, 'utf8') }
}

export function assertStepWithinBudget(input: {
  messages: ModelMessage[]
  contextWindowTokens?: number
  promptOverheadTokens: number
}): void {
  const size = serializedSize(input.messages)
  const estimatedInputTokens = Math.ceil(size.bytes / 2) + input.promptOverheadTokens
  const exceedsWindow = input.contextWindowTokens !== undefined
    && estimatedInputTokens > input.contextWindowTokens * COMPACTION_HARD_FRACTION
  const exceedsFallback = input.contextWindowTokens === undefined
    && size.characters > COMPACTION_FALLBACK_CHARACTERS
  if (exceedsWindow || exceedsFallback) {
    throw new ContextLimitError(estimatedInputTokens, input.contextWindowTokens)
  }
}
