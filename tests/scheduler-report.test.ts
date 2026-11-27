import { describe, expect, it } from 'vitest'
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider'
import { MockLanguageModelV3 } from 'ai/test'
import { buildPeriodReport } from '../server/scheduler/report'
import { combineReportChunks, summarizeReportChunk } from '../server/scheduler/summarizer'

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  }
}

const job = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Clock', sourceId: 'clock', sourceQuery: {}, collectCron: '*/5 * * * *', reportCron: '0 * * * *', timezone: 'Europe/Moscow', summaryInstruction: 'include all values', status: 'active' as const,
  nextCollectAt: '2026-11-26T10:05:00.000Z', nextReportAt: '2026-11-26T11:00:00.000Z', createdAt: '2026-11-26T10:00:00.000Z', updatedAt: '2026-11-26T10:00:00.000Z',
}

describe('scheduled period reports', () => {
  it('reads every MCP page and records every run ID', async () => {
    let page = 0
    const members: string[] = []
    const result = await buildPeriodReport({
      reportId: 'report', job, from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T11:00:00.000Z',
      readPeriod: async () => ++page === 1
        ? { items: [{ runId: 'one', scheduledFor: '2026-11-26T10:05:00.000Z', observedAt: '2026-11-26T10:05:01.000Z', payload: { value: 1 } }], nextCursor: 'next' }
        : { items: [{ runId: 'two', scheduledFor: '2026-11-26T10:10:00.000Z', observedAt: '2026-11-26T10:10:01.000Z', payload: { value: 2 } }] },
      addMembers: (_reportId, ids) => members.push(...ids),
      counts: () => ({ runCount: 2, successCount: 2, failureCount: 0, missedCount: 0 }),
      summarizeChunk: async ({ items }) => items.map(item => JSON.stringify(item.payload)).join('\n'),
      combineSummaries: async ({ chunks }) => chunks.join('\n'),
    })
    expect(result.report.status).toBe('completed')
    expect(result.report.resultCount).toBe(2)
    expect(members).toEqual(['one', 'two'])
    expect(result.report.text).toContain('value')
  })

  it('does not mark a report complete after a repeated cursor', async () => {
    const result = await buildPeriodReport({
      reportId: 'report', job, from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T11:00:00.000Z',
      readPeriod: async () => ({ items: [], nextCursor: 'same' }),
      addMembers: () => {},
      counts: () => ({ runCount: 0, successCount: 0, failureCount: 0, missedCount: 0 }),
      summarizeChunk: async () => '',
      combineSummaries: async () => '',
    })
    expect(result.report.status).toBe('failed')
    expect(result.report.error).toContain('repeated cursor')
  })

  it('keeps the counts and records a failed report when the LLM fails', async () => {
    const result = await buildPeriodReport({
      reportId: 'report', job, from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T11:00:00.000Z',
      readPeriod: async () => ({ items: [{ runId: 'one', scheduledFor: '2026-11-26T10:05:00.000Z', observedAt: '2026-11-26T10:05:01.000Z', payload: { value: 1 } }] }),
      addMembers: () => {},
      counts: () => ({ runCount: 1, successCount: 1, failureCount: 0, missedCount: 0 }),
      summarizeChunk: async () => { throw new Error('LLM unavailable') },
      combineSummaries: async () => '',
    })
    expect(result.report).toMatchObject({ status: 'failed', textStatus: 'failed', resultCount: 1, runCount: 1, error: 'LLM unavailable' })
  })

  it('uses the LLM for every data chunk and the final combined report', async () => {
    const model = new MockLanguageModelV3({ doGenerate: [textResult('Часть 1'), textResult('Часть 2'), textResult('Итог LLM')] })
    const items = Array.from({ length: 21 }, (_, index) => ({
      runId: `run-${index}`,
      scheduledFor: `2026-11-26T10:${String(index).padStart(2, '0')}:00.000Z`,
      observedAt: `2026-11-26T10:${String(index).padStart(2, '0')}:01.000Z`,
      payload: { value: index },
    }))
    const result = await buildPeriodReport({
      reportId: 'report', job, from: '2026-11-26T10:00:00.000Z', to: '2026-11-26T11:00:00.000Z',
      readPeriod: async () => ({ items }),
      addMembers: () => {},
      counts: () => ({ runCount: 21, successCount: 21, failureCount: 0, missedCount: 0 }),
      summarizeChunk: input => summarizeReportChunk({ ...input, model }),
      combineSummaries: input => combineReportChunks({ ...input, model }),
    })
    expect(result.report).toMatchObject({ status: 'completed', resultCount: 21, text: 'Итог LLM' })
    expect(model.doGenerateCalls).toHaveLength(3)
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('run-19')
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('run-20')
    expect(JSON.stringify(model.doGenerateCalls[2]?.prompt)).toContain('Часть 1')
    expect(JSON.stringify(model.doGenerateCalls[2]?.prompt)).toContain('Часть 2')
  })
})
