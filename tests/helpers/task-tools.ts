import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from 'ai'
import { recordToolExecution } from '../../server/agent/recorded-tools'
import { openChatDatabase } from '../../server/persistence/db'
import { createTurnRepository } from '../../server/persistence/turn-repository'
import { createFileTools } from '../../server/tools/files/file-tools'
import { fixture, workflow } from '../task-workflow-fixture'

export function taskToolFixture(basic = false) {
  const rootDir = mkdtempSync(join(tmpdir(), 'task-operation-'))
  const db = openChatDatabase(join(rootDir, 'chat.sqlite'))
  const definition = structuredClone(workflow)
  definition.nodes[0]!.allowedTools = ['read_file', 'write_file']
  const f = fixture(db, basic, definition)
  const turns = createTurnRepository(db)
  const { turnId } = turns.beginUserTurn({ requestId: randomUUID(), sessionId: f.sessionId, modelId: 'test',
    message: { id: randomUUID(), role: 'user', parts: [] }, agentConfig: {} })
  db.prepare('UPDATE turns SET task_id = ? WHERE id = ?').run(f.id, turnId)
  const actor = { role: 'agent' as const, turnId, sessionId: f.sessionId, stepNodeVisitId: f.view().task!.nodeVisitId, stepIndex: 3 }
  const user = { role: 'user' as const, sessionId: f.sessionId }
  const task = { db, taskId: f.id, getActor: () => actor }
  function wrap(source: Tool, toolName: string) {
    return recordToolExecution(source, { turnId, getStepIndex: () => 3, repository: turns, toolName, task })
  }
  function write(toolCallId = randomUUID() as string, content = 'ok') {
    const wrapped = wrap(createFileTools({ rootDir }).write_file, 'write_file')
    return () => wrapped.execute!({ actionKey: 'report-v1', path: 'out.txt', content }, { toolCallId, messages: [], context: {} })
  }
  return { ...f, task, turns, actor, user, rootDir, write, wrap, exists: () => existsSync(join(rootDir, 'out.txt')),
    close() { db.close(); rmSync(rootDir, { recursive: true, force: true }) } }
}
