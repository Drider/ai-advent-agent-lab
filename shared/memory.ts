import type { UIMessage } from 'ai'

export const DEFAULT_MEMORY_BUDGETS = {
  workingTokens: 2_000,
  longTermTokens: 2_000,
} as const

export const MEMORY_BUDGET_MIN = 100
export const MEMORY_BUDGET_MAX = 100_000

export type WorkingMemoryCategory = 'goal' | 'constraint' | 'state' | 'result' | 'note'
export type LongTermMemoryCategory = 'profile' | 'decision' | 'knowledge'

export interface MemoryBudgets {
  workingTokens: number
  longTermTokens: number
  revision: number
}

export interface MemoryBudgetPatch {
  workingTokens?: number
  longTermTokens?: number
  expectedRevision: number
}

export interface MemorySource {
  sourceSessionId?: string
  sourceMessageId?: string
}

export interface MemoryEntryBase extends MemorySource {
  id: string
  key: string
  value: string
  enabled: boolean
  revision: number
  createdAt: string
  updatedAt: string
}

export interface WorkingMemoryEntry extends MemoryEntryBase {
  projectId: string
  category: WorkingMemoryCategory
}

export interface LongTermFact extends MemoryEntryBase {
  category: LongTermMemoryCategory
  global: boolean
  projectIds: string[]
}

export interface Project {
  id: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface MemoryListQuery {
  cursor?: string
  limit?: number
  text?: string
  category?: string
}

export interface MemoryPage<T> {
  items: T[]
  nextCursor?: string
}

export type MemoryLayer = 'working' | 'long_term'

export type MemoryExclusionReason = 'disabled' | 'not_relevant' | 'budget_exceeded'

export interface MemoryExclusionRef {
  id: string
  revision: number
  layer: MemoryLayer
  reason: MemoryExclusionReason
}

export interface MemoryLayerPreview {
  count: number
  bytes: number
  estimatedTokens: number
  budgetTokens: number
  percent: number
  exceeded: boolean
}

export interface MemoryPreview {
  projectId?: string
  working: MemoryLayerPreview
  longTerm: MemoryLayerPreview
  exclusions: MemoryExclusionRef[]
}

export type MemorySelectionReason = 'working_project' | 'global' | 'project'

export interface MemorySelectionRef {
  id: string
  revision: number
  reasons: MemorySelectionReason[]
}

export interface MemorySnapshot {
  id: string
  sessionId: string
  projectId?: string
  budgets: MemoryBudgets
  workingEntries: WorkingMemoryEntry[]
  longTermFacts: LongTermFact[]
  workingRefs: MemorySelectionRef[]
  longTermRefs: MemorySelectionRef[]
  messages: UIMessage[]
  preview: MemoryPreview
  transientMemory: {
    messages: Array<{ id: string; layer: MemoryLayer; text: string }>
  }
}

export interface MemoryUsageNumbers {
  count: number
  bytes: number
  estimatedTokens: number
}

export interface MemoryUsageEvent {
  id: string
  snapshotId: string
  sessionId: string
  projectId?: string
  turnId?: string
  preparedAt: string
  contextCleared: boolean
  shortTerm: MemoryUsageNumbers
  working: MemoryUsageNumbers
  longTerm: MemoryUsageNumbers
  workingRefs: MemorySelectionRef[]
  longTermRefs: MemorySelectionRef[]
  exclusions: MemoryExclusionRef[]
}

export type MemoryScope =
  | { scope: 'dialogue'; sessionId: string }
  | { scope: 'project'; projectId: string }
  | { scope: 'global' }

export interface MemoryStoredLayer extends MemoryUsageNumbers {
  messages?: number
  entries?: number
  facts?: number
}

export interface MemoryRecordUsage {
  id: string
  layer: 'working' | 'long_term'
  preparedTurns: number
  lastPreparedAt?: string
  revisionMismatch: boolean
}

export interface MemoryStatistics {
  scope: MemoryScope['scope']
  sessionId?: string
  projectId?: string
  collectionStartedAt?: string
  stored: {
    shortTerm: MemoryStoredLayer
    working: MemoryStoredLayer
    longTerm: MemoryStoredLayer
    summaries: number
    stickyFacts: number
  }
  preparedTurns: number
  lastPrepared?: MemoryUsageEvent
  recordUsage: MemoryRecordUsage[]
}

export type HistoryClearStatus = 'pending_files' | 'completed' | 'failed'

export interface HistoryClearResult {
  operationId: string
  sessionId: string
  status: HistoryClearStatus
  oldRunLogId?: string
  newRunLogId?: string
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface CreateWorkingEntry extends MemorySource {
  projectId: string
  category: WorkingMemoryCategory
  key: string
  value: string
  enabled?: boolean
}

export interface UpdateWorkingEntry {
  category?: WorkingMemoryCategory
  key?: string
  value?: string
  enabled?: boolean
  expectedRevision: number
}

export interface CreateLongTermFact extends MemorySource {
  category: LongTermMemoryCategory
  key: string
  value: string
  enabled?: boolean
  global?: boolean
  projectIds?: string[]
}

export interface UpdateLongTermFact {
  category?: LongTermMemoryCategory
  key?: string
  value?: string
  enabled?: boolean
  global?: boolean
  projectIds?: string[]
  expectedRevision: number
}

export function assertMemoryBudget(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MEMORY_BUDGET_MIN || value > MEMORY_BUDGET_MAX) {
    throw new Error(`${field} must be an integer between ${MEMORY_BUDGET_MIN} and ${MEMORY_BUDGET_MAX}`)
  }
}

export function validateMemoryBudgetPatch(input: MemoryBudgetPatch): MemoryBudgetPatch {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer')
  }
  if (input.workingTokens !== undefined) assertMemoryBudget(input.workingTokens, 'workingTokens')
  if (input.longTermTokens !== undefined) assertMemoryBudget(input.longTermTokens, 'longTermTokens')
  if (input.workingTokens === undefined && input.longTermTokens === undefined) {
    throw new Error('at least one memory budget must be provided')
  }
  return input
}
