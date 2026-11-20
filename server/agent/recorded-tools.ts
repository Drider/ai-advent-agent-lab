import type { Tool, ToolExecutionOptions } from 'ai'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { JsonValue, TaskActorContext } from '../../shared/task'
import { TaskError } from '../tasks/errors'
import { sha256 } from '../tasks/tool-operation-store'
import { actionKeyPattern, createTaskToolOperations } from '../tasks/tool-operations'
import { workingTool } from '../tasks/tool-registry'

export interface RecordedToolRepository {
  recordToolStart(input: {
    turnId: string
    toolCallId: string
    stepIndex: number
    name: string
    input: unknown
  }): boolean | void | Promise<boolean | void>
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
    task?: { db: Database.Database; taskId: string; getActor: () => TaskActorContext }
  },
): Tool<TInput, TOutput, TContext> {
  if (!originalTool.execute) {
    throw new Error('durable tool execution requires a tool with execute')
  }

  const execute = originalTool.execute
  const toolName = options.toolName ?? originalTool.title ?? 'tool'

  if (options.task) {
    const { db, taskId, getActor } = options.task
    const operations = createTaskToolOperations(db)
    const mutating = workingTool(toolName)?.mutating
    const schema = originalTool.inputSchema
    if (mutating && !(schema instanceof z.ZodObject)) throw new Error('Mutating task tool requires an object schema')
    const inputSchema = mutating && schema instanceof z.ZodObject
      ? schema.safeExtend({ actionKey: z.string().regex(actionKeyPattern).describe('Stable ID for this logical action. Reuse for a retry.') })
      : schema
    return {
      ...originalTool,
      inputSchema,
      execute: async (raw: TInput, executionOptions: ToolExecutionOptions<TContext>) => {
        const actor = getActor()
        const { toolCallId } = executionOptions
        const { actionKey, ...args } = (raw ?? {}) as Record<string, unknown>
        if (mutating && (typeof actionKey !== 'string' || !actionKeyPattern.test(actionKey))) {
          throw new TaskError('INVALID_INPUT', 'A stable ASCII actionKey (1–80 characters) is required')
        }
        const reserve = () => operations.reserve({
          taskId, toolName, actor, turnId: options.turnId, nodeVisitId: actor.stepNodeVisitId ?? null, toolCallId,
          actionKey: mutating ? actionKey as string : '/read/' + sha256(JSON.stringify([options.turnId, toolCallId])),
          input: args as JsonValue,
        })
        const sqlite = (execute as typeof execute & { sqlite?: (args: TInput, options: ToolExecutionOptions<TContext>) => TOutput }).sqlite
        if (sqlite) {
          return db.transaction(() => {
            const decision = reserve()
            if (decision.kind === 'replay') return decision.output
            const result = sqlite(args as TInput, toolName === 'rollDie' ? { ...executionOptions, toolCallId: decision.id } : executionOptions)
            const output: JsonValue = JSON.parse(JSON.stringify(result))
            operations.complete(decision.id, output)
            return output
          }).immediate()
        }
        const decision = reserve()
        if (decision.kind === 'replay') return decision.output
        try {
          // No await between committing authorization and starting the effect.
          const result = await execute(args as TInput, executionOptions)
          const output: JsonValue = JSON.parse(JSON.stringify(result))
          operations.complete(decision.id, output)
          return output
        } catch (error) {
          // A failed final commit rolls back both receipts. If the database is
          // unavailable, the original intent remains available to restart recovery.
          try { operations.fail(decision.id, error) } catch {}
          throw error
        }
      },
    } as Tool<TInput, TOutput, TContext>
  }

  return {
    ...originalTool,
    execute: async (input: TInput, executionOptions: ToolExecutionOptions<TContext>) => {
      const started = await options.repository.recordToolStart({
        turnId: options.turnId,
        toolCallId: executionOptions.toolCallId,
        stepIndex: options.getStepIndex(),
        name: toolName,
        input,
      })
      // The persistent repository returns false when the turn was stopped or
      // the call was already recorded. In either case, executing the wrapped
      // tool would create an untracked (and possibly duplicated) side effect.
      // Void is kept as a successful result for lightweight/test repositories.
      if (started === false) {
        throw new Error('tool execution was cancelled because the turn is no longer running')
      }

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
