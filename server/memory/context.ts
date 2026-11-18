import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { UIMessage } from 'ai'
import { estimateInputTokens } from '../context-compaction/estimate'
import { createLongTermMemoryRepository } from './long-term-repository'
import { MemoryError } from './errors'
import { createMemorySettingsRepository } from './settings-repository'
import { createWorkingMemoryRepository } from './working-repository'
import { createMemoryMessage, selectMemoryEntries } from './selection'
import type {
  LongTermFact,
  MemoryLayerPreview,
  MemoryPreview,
  MemorySelectionRef,
  MemorySnapshot,
  WorkingMemoryEntry,
} from '../../shared/memory'

function layerPreview(
  message: UIMessage | undefined,
  count: number,
  budgetTokens: number,
): MemoryLayerPreview {
  const bytes = message === undefined ? 0 : Buffer.byteLength(JSON.stringify({ role: message.role, parts: message.parts }), 'utf8')
  const estimatedTokens = message === undefined ? 0 : estimateInputTokens([message], 0)
  const percent = budgetTokens === 0 ? 0 : estimatedTokens / budgetTokens * 100
  return { count, bytes, estimatedTokens, budgetTokens, percent, exceeded: estimatedTokens > budgetTokens }
}

function projectIdForSession(db: Database.Database, sessionId: string): string | undefined {
  const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined
  if (!row) throw new MemoryError('NOT_FOUND', 'session was not found')
  return row.project_id ?? undefined
}

function selectionQuery(db: Database.Database, sessionId: string, currentMessage?: UIMessage): string {
  const rows = db.prepare(`
    SELECT payload_json FROM messages
    WHERE session_id = ? AND role = 'user' AND status = 'complete' AND id != ?
    ORDER BY position DESC LIMIT 3
  `).all(sessionId, currentMessage?.id ?? '') as Array<{ payload_json: string }>
  const messages = rows.map(row => JSON.parse(row.payload_json) as UIMessage)
  if (currentMessage?.role === 'user') messages.push(currentMessage)
  return messages.flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n')
}

function loadWorkingEntries(db: Database.Database, projectId: string): WorkingMemoryEntry[] {
  const repository = createWorkingMemoryRepository(db)
  const entries: WorkingMemoryEntry[] = []
  let cursor: string | undefined
  do {
    const page = repository.list(projectId, { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
    entries.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return entries
}

function loadLongTermFacts(db: Database.Database, projectId: string | undefined): LongTermFact[] {
  const repository = createLongTermMemoryRepository(db)
  const facts: LongTermFact[] = []
  let cursor: string | undefined
  do {
    const page = repository.list({
      limit: 100,
      ...(projectId === undefined ? {} : { projectId }),
      ...(cursor === undefined ? {} : { cursor }),
    })
    facts.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return facts.filter(fact => projectId !== undefined || fact.global)
}

function selectMemory(db: Database.Database, projectId: string | undefined, query: string): {
  working: WorkingMemoryEntry[]
  longTerm: LongTermFact[]
  preview: MemoryPreview
  messages: UIMessage[]
  transientMemory: MemorySnapshot['transientMemory']
  workingRefs: MemorySelectionRef[]
  longTermRefs: MemorySelectionRef[]
} {
  const budgets = createMemorySettingsRepository(db).get()
  const workingSelection = selectMemoryEntries(
    projectId === undefined ? [] : loadWorkingEntries(db, projectId), query, budgets.workingTokens,
    'Working memory',
  )
  const longTermSelection = selectMemoryEntries(
    loadLongTermFacts(db, projectId), query, budgets.longTermTokens,
    'Long-term memory',
  )
  const working = workingSelection.entries
  const longTerm = longTermSelection.entries
  const workingMessage = createMemoryMessage(
    `memory-selection-working-${randomUUID()}`,
    'Working memory',
    working,
  )
  const longTermMessage = createMemoryMessage(
    `memory-selection-long-term-${randomUUID()}`,
    'Long-term memory',
    longTerm,
  )
  // Replace random IDs with stable IDs only after the snapshot identity exists in createMemorySnapshot.
  const messages = [workingMessage, longTermMessage].filter((message): message is UIMessage => message !== undefined)
  const workingRefs = working.map(entry => ({ id: entry.id, revision: entry.revision, reasons: ['working_project'] as MemorySelectionRef['reasons'] }))
  const longTermRefs = longTerm.map(fact => ({
    id: fact.id,
    revision: fact.revision,
    reasons: [
      ...(fact.global ? ['global' as const] : []),
      ...(projectId !== undefined && fact.projectIds.includes(projectId) ? ['project' as const] : []),
    ],
  }))
  const preview = {
    ...(projectId === undefined ? {} : { projectId }),
    working: layerPreview(workingMessage, working.length, budgets.workingTokens),
    longTerm: layerPreview(longTermMessage, longTerm.length, budgets.longTermTokens),
    exclusions: [
      ...workingSelection.exclusions.map(ref => ({ ...ref, layer: 'working' as const })),
      ...longTermSelection.exclusions.map(ref => ({ ...ref, layer: 'long_term' as const })),
    ],
  }
  return {
    working,
    longTerm,
    preview,
    messages,
    transientMemory: {
      messages: messages.map(message => ({
        id: message.id,
        layer: message.id.includes('long-term') ? 'long_term' : 'working',
        text: message.parts.filter(part => part.type === 'text').map(part => part.text).join(''),
      })),
    },
    workingRefs,
    longTermRefs,
  }
}

export function createMemorySnapshot(db: Database.Database, sessionId: string, currentMessage?: UIMessage): MemorySnapshot {
  const projectId = projectIdForSession(db, sessionId)
  const id = randomUUID()
  const selected = selectMemory(db, projectId, selectionQuery(db, sessionId, currentMessage))
  const workingMessage = selected.messages.find(message => message.id.includes('working'))
  const longTermMessage = selected.messages.find(message => message.id.includes('long-term'))
  if (workingMessage) workingMessage.id = `memory-${id}-working`
  if (longTermMessage) longTermMessage.id = `memory-${id}-long-term`
  selected.transientMemory.messages = selected.messages.map(message => ({
    id: message.id,
    layer: message.id.endsWith('-long-term') ? 'long_term' : 'working',
    text: message.parts.filter(part => part.type === 'text').map(part => part.text).join(''),
  }))
  return {
    id,
    sessionId,
    ...(projectId === undefined ? {} : { projectId }),
    budgets: createMemorySettingsRepository(db).get(),
    workingEntries: selected.working.map(entry => ({ ...entry })),
    longTermFacts: selected.longTerm.map(fact => ({ ...fact, projectIds: [...fact.projectIds] })),
    workingRefs: selected.workingRefs.map(ref => ({ ...ref, reasons: [...ref.reasons] })),
    longTermRefs: selected.longTermRefs.map(ref => ({ ...ref, reasons: [...ref.reasons] })),
    messages: selected.messages,
    preview: selected.preview,
    transientMemory: selected.transientMemory,
  }
}

export function previewMemory(db: Database.Database, projectId?: string, query = ''): MemoryPreview {
  return selectMemory(db, projectId, query).preview
}

export function assertMemoryBudgets(snapshot: MemorySnapshot): void {
  const layers: Array<{ name: 'working' | 'long_term'; preview: MemoryLayerPreview }> = [
    { name: 'working', preview: snapshot.preview.working },
    { name: 'long_term', preview: snapshot.preview.longTerm },
  ]
  for (const layer of layers) {
    if (layer.preview.exceeded) {
      throw new MemoryError(
        'MEMORY_BUDGET_EXCEEDED',
        `required ${layer.name} memory exceeds its context budget (${layer.preview.estimatedTokens}/${layer.preview.budgetTokens} estimated tokens)`,
        { layer: layer.name, estimatedTokens: layer.preview.estimatedTokens, budgetTokens: layer.preview.budgetTokens },
      )
    }
  }
}

