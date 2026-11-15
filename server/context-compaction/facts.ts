import { generateText, type LanguageModel } from 'ai'
import type { ChatTokenUsage, ChatUIMessage } from '../../shared/chat'
import type { StickyFacts } from './facts-repository'

const MAX_FACTS = 64
const MAX_FACT_KEY_LENGTH = 80
const MAX_FACT_VALUE_LENGTH = 1_000

function messageText(message: ChatUIMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatUIMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('')
}

function parseFacts(text: string): StickyFacts {
  const normalized = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
  const parsed = JSON.parse(normalized) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('facts extractor must return a JSON object')
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length > MAX_FACTS) throw new Error(`facts extractor returned more than ${MAX_FACTS} facts`)
  const facts: StickyFacts = {}
  for (const [key, value] of entries) {
    if (!key.trim() || key.length > MAX_FACT_KEY_LENGTH || typeof value !== 'string' || value.length > MAX_FACT_VALUE_LENGTH) {
      throw new Error('facts extractor returned an invalid key or value')
    }
    facts[key] = value.trim()
  }
  return facts
}

export async function updateFacts(input: {
  model: LanguageModel
  previousFacts: StickyFacts
  userMessage: ChatUIMessage
  abortSignal?: AbortSignal
}): Promise<{ facts: StickyFacts; usage?: ChatTokenUsage }> {
  const result = await generateText({
    model: input.model,
    prompt: [
      'Update the durable key-value memory for a chat.',
      'Return JSON only: an object whose keys are short fact names and whose values are concise strings.',
      'Keep important goals, constraints, preferences, decisions, agreements, names, dates, numbers, and next steps.',
      'Preserve previous facts unless the new user message clearly replaces or corrects them.',
      'If the new user message adds no durable fact, return the previous facts unchanged.',
      'Do not add facts from the assistant or tools. Do not invent missing facts.',
      `<previous_facts>${JSON.stringify(input.previousFacts)}</previous_facts>`,
      `<new_user_message>${messageText(input.userMessage)}</new_user_message>`,
    ].join('\n'),
    maxOutputTokens: 1_024,
    abortSignal: input.abortSignal,
  })
  const text = result.text.trim()
  // Some reasoning-capable providers may finish a maintenance call without a
  // visible text part when there is nothing new to remember. Treat that as a
  // no-op instead of failing the user's primary chat request or erasing facts.
  return {
    facts: text.length === 0 ? input.previousFacts : parseFacts(text),
    usage: result.usage as ChatTokenUsage | undefined,
  }
}
