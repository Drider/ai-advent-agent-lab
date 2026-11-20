import { tool } from 'ai'
import { z } from 'zod'
import type { TaskCommand } from '../../../shared/task'
import { createTaskService } from '../../tasks/commands'
import { TaskError } from '../../tasks/errors'
import { assertTaskExecutionAllowed } from '../../tasks/tool-policy'
import type { TaskRuntime } from '../../tasks/turn-runtime'
import { expectedActionSchema } from '../../workflows/schema'

const commandFields = {
  operationId: z.string().min(1).describe('Stable id for this command and its exact retries'),
  expectedRevision: z.number().int().nonnegative(),
}
export function createTaskTools({ runtime }: Pick<TaskRuntime, 'db' | 'sessionId' | 'turnId' | 'taskId'> & { runtime: TaskRuntime }) {
  const { db, sessionId, taskId } = runtime
  const service = createTaskService(db)
  function denied(error: unknown) {
    if (!(error instanceof TaskError)) throw error
    return { ok: false as const, error: { code: error.code, message: error.message }, task: service.view(taskId, sessionId).task }
  }
  async function apply(input: { operationId: string; expectedRevision: number }, command: TaskCommand,
    options: { context?: unknown; toolCallId: string }) {
    try {
      return await service.apply(taskId, { operationId: input.operationId, expectedRevision: input.expectedRevision, command },
        runtime.getActor(options.context), { toolCallId: options.toolCallId })
    } catch (error) { return denied(error) }
  }
  return {
    get_task_state: tool({ description: 'Read the canonical current task.', inputSchema: z.strictObject({}),
      execute: async (_, options) => {
        try { return { ok: true, task: assertTaskExecutionAllowed(db, taskId, runtime.getActor(options.context), false) } }
        catch (error) { return denied(error) }
      } }),
    update_task_progress: tool({ description: 'Save progress or specify the next expected input.',
      inputSchema: z.strictObject({ ...commandFields, progress: z.string(), expected: expectedActionSchema.optional() }),
      execute: ({ operationId, expectedRevision, ...payload }, options) => apply({ operationId, expectedRevision }, { type: 'update_progress', ...payload }, options) }),
    submit_task_artifact: tool({ description: 'Save a version of a task-owned artifact with its real sources.',
      inputSchema: z.strictObject({ ...commandFields, key: z.string(), content: z.json(), sourceMessageIds: z.array(z.string()), sourceToolCallIds: z.array(z.string()) }),
      execute: ({ operationId, expectedRevision, ...payload }, options) => apply({ operationId, expectedRevision }, { type: 'submit_artifact', ...payload }, options) }),
    request_task_transition: tool({ description: 'Request a published transition by its exact ID.',
      inputSchema: z.strictObject({ ...commandFields, transitionId: z.string() }),
      execute: (input, options) => apply(input, { type: 'transition', transitionId: input.transitionId }, options) }),
    run_task_checks: tool({ description: 'Run the formal checks assigned to this node.',
      inputSchema: z.strictObject({ ...commandFields, checkIds: z.array(z.string()).optional() }),
      execute: (input, options) => apply(input, { type: 'validate', checkIds: input.checkIds }, options) }),
    finish_task: tool({ description: 'Finish with the exact result artifact ID, or with result text for a basic task.',
      inputSchema: z.strictObject({ ...commandFields, resultArtifactId: z.string().optional(), resultText: z.string().optional() }),
      execute: ({ operationId, expectedRevision, ...payload }, options) => apply({ operationId, expectedRevision }, { type: 'finish', ...payload }, options) }),
  }
}
