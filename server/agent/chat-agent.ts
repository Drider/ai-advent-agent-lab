import {
  createAgentUIStreamResponse,
  isStepCount,
  ToolLoopAgent,
  type LanguageModel,
  type UIMessage,
} from 'ai'
import { createDiceTool } from './dice-tool'

export const MAX_AGENT_STEPS = 10
export const AGENT_TIMEOUT_MS = 30_000

const AGENT_INSTRUCTIONS = [
  'You are a concise chat agent with one tool named rollDie.',
  'When the user asks to roll a die, always call rollDie and never invent a random result.',
  'For dN requests, pass sides=N; when no die type is specified, pass sides=6.',
  'For multiple rolls, call rollDie once for each requested roll and use every returned result.',
  'After receiving tool results, answer the user using the exact results returned by the tool.',
].join(' ')

function stopAtStepLimit() {
  const isLimitReached = isStepCount(MAX_AGENT_STEPS)

  return ({ steps }: { steps: unknown[] }) => {
    if (isLimitReached({ steps } as never)) {
      throw new Error(`agent stopped after ${MAX_AGENT_STEPS} steps`)
    }

    return false
  }
}

export function createChatAgent(
  model: LanguageModel,
  diceTool = createDiceTool(),
): ToolLoopAgent<never, { rollDie: typeof diceTool }> {
  return new ToolLoopAgent({
    model,
    instructions: AGENT_INSTRUCTIONS,
    tools: {
      rollDie: diceTool,
    },
    stopWhen: stopAtStepLimit(),
    timeout: { totalMs: AGENT_TIMEOUT_MS },
  })
}

export async function streamChatAgent(input: {
  model: LanguageModel
  modelId: string
  messages: UIMessage[]
  abortSignal?: AbortSignal
}, diceTool = createDiceTool()): Promise<Response> {
  return createAgentUIStreamResponse({
    agent: createChatAgent(input.model, diceTool),
    uiMessages: input.messages,
    abortSignal: input.abortSignal,
    timeout: { totalMs: AGENT_TIMEOUT_MS },
    onError: () => 'Не удалось получить ответ агента. Проверьте настройки модели и повторите запрос.',
  })
}
