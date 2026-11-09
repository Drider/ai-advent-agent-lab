import {
  createAgentUIStreamResponse,
  isStepCount,
  ToolLoopAgent,
  type LanguageModelUsage,
  type LanguageModel,
  type UIMessage,
} from 'ai'
import { appendRunLogEntry, type RunLogEntry, type RunLogLevel } from '../utils/run-logger'
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
  options: { includeRawChunks?: boolean } = {},
): ToolLoopAgent<never, { rollDie: typeof diceTool }> {
  return new ToolLoopAgent({
    model,
    instructions: AGENT_INSTRUCTIONS,
    tools: {
      rollDie: diceTool,
    },
    stopWhen: stopAtStepLimit(),
    timeout: { totalMs: AGENT_TIMEOUT_MS },
    include: {
      requestMessages: true,
      rawChunks: options.includeRawChunks === true,
    },
  })
}

function getMessageText(message: UIMessage | undefined): string {
  if (!message) {
    return ''
  }

  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => {
      return part.type === 'text'
    })
    .map(part => part.text)
    .join('')
}

function getLastUserQuestion(messages: UIMessage[]): string {
  const message = [...messages]
    .reverse()
    .find(candidate => candidate.role === 'user')

  return getMessageText(message)
}

function sumUsage(steps: Array<{ usage?: LanguageModelUsage }>): LanguageModelUsage | undefined {
  if (steps.length === 0) {
    return undefined
  }

  const sum = (selector: (usage: LanguageModelUsage) => number | undefined) => {
    return steps.reduce((total, step) => total + (step.usage ? selector(step.usage) ?? 0 : 0), 0)
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

function getErrorStatus(outcome: { status: string }): string | undefined {
  return outcome.status === 'failed' ? 'Agent request failed' : undefined
}

export async function streamChatAgent(input: {
  model: LanguageModel
  modelId: string
  messages: UIMessage[]
  abortSignal?: AbortSignal
  runId: string
  logLevel: RunLogLevel
}, diceTool = createDiceTool()): Promise<Response> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const steps: Array<{ usage?: LanguageModelUsage; [key: string]: unknown }> = []
  let logStarted = false

  const persistLog = async (responseMessage: UIMessage | undefined, error?: string) => {
    if (logStarted) {
      return
    }
    logStarted = true

    const lastStep = steps.at(-1)
    const entry: RunLogEntry = {
      runId: input.runId,
      level: input.logLevel,
      question: getLastUserQuestion(input.messages),
      answer: error === undefined ? getMessageText(responseMessage) : undefined,
      error,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      usage: sumUsage(steps),
      request: {
        model: input.modelId,
        messages: input.messages,
      },
      response: lastStep
        ? {
            finishReason: typeof lastStep.finishReason === 'string' ? lastStep.finishReason : undefined,
            rawFinishReason: typeof lastStep.rawFinishReason === 'string'
              ? lastStep.rawFinishReason
              : undefined,
            id: typeof lastStep.response === 'object'
              && lastStep.response !== null
              && 'id' in lastStep.response
              && typeof lastStep.response.id === 'string'
              ? lastStep.response.id
              : undefined,
            modelId: typeof lastStep.model === 'object'
              && lastStep.model !== null
              && 'modelId' in lastStep.model
              && typeof lastStep.model.modelId === 'string'
              ? lastStep.model.modelId
              : undefined,
          }
        : undefined,
      steps,
      rawResponse: input.logLevel === 'raw' ? [] : undefined,
    }

    try {
      await appendRunLogEntry(entry)
    } catch {
      // Logging must never turn a completed or safe error stream into a failure.
      console.error('[chat-agent] failed to save run log')
    }
  }

  return createAgentUIStreamResponse({
    agent: createChatAgent(input.model, diceTool, {
      includeRawChunks: input.logLevel === 'raw',
    }),
    uiMessages: input.messages,
    abortSignal: input.abortSignal,
    timeout: { totalMs: AGENT_TIMEOUT_MS },
    onStepEnd: (step) => {
      steps.push(step as unknown as { usage?: LanguageModelUsage; [key: string]: unknown })
    },
    onEnd: async (event) => {
      await persistLog(event.responseMessage, getErrorStatus(event.outcome))
    },
    onError: () => 'Не удалось получить ответ агента. Проверьте настройки модели и повторите запрос.',
  })
}
