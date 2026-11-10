import type { Tool, ToolExecutionOptions } from 'ai'

export interface RecordedToolRepository {
  recordToolStart(input: {
    turnId: string
    toolCallId: string
    stepIndex: number
    name: string
    input: unknown
  }): void | Promise<void>
  recordToolEnd(input: {
    turnId: string
    toolCallId: string
    output?: unknown
    error?: unknown
  }): void | Promise<void>
}

export function recordToolExecution<TInput, TOutput, TContext = unknown>(
  originalTool: Tool<TInput, TOutput, TContext>,
  options: {
    turnId: string
    getStepIndex: () => number
    repository: RecordedToolRepository
    toolName?: string
  },
): Tool<TInput, TOutput, TContext> {
  if (!originalTool.execute) {
    throw new Error('durable tool execution requires a tool with execute')
  }

  const execute = originalTool.execute
  const toolName = options.toolName ?? originalTool.title ?? 'tool'

  return {
    ...originalTool,
    execute: async (input: TInput, executionOptions: ToolExecutionOptions<TContext>) => {
      await options.repository.recordToolStart({
        turnId: options.turnId,
        toolCallId: executionOptions.toolCallId,
        stepIndex: options.getStepIndex(),
        name: toolName,
        input,
      })

      let output: TOutput
      try {
        output = await execute(input, executionOptions) as TOutput
      } catch (error) {
        try {
          await options.repository.recordToolEnd({
            turnId: options.turnId,
            toolCallId: executionOptions.toolCallId,
            error,
          })
        } catch {
          // The original failure remains the actionable tool error; the
          // still-running DB row is intentionally left for recovery review.
        }
        throw error
      }

      await options.repository.recordToolEnd({
        turnId: options.turnId,
        toolCallId: executionOptions.toolCallId,
        output,
      })
      return output
    },
  } as Tool<TInput, TOutput, TContext>
}
