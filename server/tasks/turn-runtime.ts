import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { TaskActorContext } from '../../shared/task'
import { startMemoryAwareTurn } from '../memory/start-turn'
import { createTurnRepository } from '../persistence/turn-repository'
import { taskToolNames } from '../tools/tasks/instructions'
import { createTaskService } from './commands'
import { prepareTaskContext } from './context'
import { TaskError } from './errors'
import { workingToolNames, workingTool } from './tool-registry'

type StartInput = Parameters<typeof startMemoryAwareTurn>[1] & { workflow?: { id: string; version: number } | null }

export function startTaskAwareTurn(db: Database.Database, input: StartInput) {
  return db.transaction(() => {
    const { request } = input
    createTurnRepository(db).assertCanStart(request.sessionId, request.requestId)
    const task = createTaskService(db).reserveForTurn({ ...request, workflow: input.workflow,
      sourceTurnId: request.kind === 'continue' ? request.sourceTurnId : undefined,
      messageText: request.message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    }, { role: 'system', sessionId: request.sessionId })
    const taskContext = task ? prepareTaskContext(db, request.sessionId, task.id) : null
    const started = startMemoryAwareTurn(db, { ...input, createAgentConfig: profile => {
      const config = input.createAgentConfig?.(profile) ?? input.agentConfig
      if (!taskContext) return config
      const instructions = [config.instructions, taskContext.instructions].filter(Boolean).join('\n\n')
      return { ...config, instructions, instructionsHash: createHash('sha256').update(instructions).digest('hex'),
        task: { id: taskContext.task.id, initialRevision: taskContext.task.revision, workflowVersion: taskContext.task.workflowVersion,
          workflowHash: taskContext.workflowHash, contextHash: taskContext.hash } }
    } })
    if (task) db.prepare('UPDATE turns SET task_id = ? WHERE id = ? AND session_id = ?').run(task.id, started.turnId, request.sessionId)
    return { ...started, taskContext }
  }).immediate()
}

export function createTaskRuntime(binding: { db: Database.Database; sessionId: string; turnId: string; taskId: string }) {
  const { db, sessionId, turnId, taskId } = binding
  const owned = new WeakSet<object>()
  const turn = db.prepare<[string, string, string], { source_turn_id: string | null }>(
    'SELECT source_turn_id FROM turns WHERE id = ? AND session_id = ? AND task_id = ?',
  ).get(turnId, sessionId, taskId)
  if (!turn) throw new TaskError('NOT_FOUND', 'Task turn was not found')
  return { ...binding,
    getActor(context: unknown): TaskActorContext {
      if (!context || typeof context !== 'object' || !owned.has(context)) throw new TaskError('TRANSITION_NOT_ALLOWED', 'Prepared tool step required')
      return context as TaskActorContext
    },
    prepareStep(stepIndex: number) {
      const context = prepareTaskContext(db, sessionId, taskId)
      const { task } = context
      const actor = Object.freeze({ role: 'agent' as const, sessionId, turnId, stepIndex, stepNodeVisitId: task.nodeVisitId }) satisfies TaskActorContext
      owned.add(actor)
      const working = (context.allowedWorkingTools ?? workingToolNames).filter(name => !turn.source_turn_id || !workingTool(name)?.mutating)
      const controls = turn.source_turn_id ? ['get_task_state'] : taskToolNames
      const activeTools = task.status === 'active' && task.recovery === 'clear' ? [...working, ...controls] : []
      return { instructions: context.instructions, activeTools, actor, contextHash: context.hash, revision: task.revision }
    },
  }
}
export type TaskRuntime = ReturnType<typeof createTaskRuntime>
