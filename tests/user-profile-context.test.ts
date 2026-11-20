import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPACTION_SETTINGS, DEFAULT_CONTEXT_STRATEGY_SETTINGS } from '../shared/chat'
import { getAgentConfig } from '../server/agent/chat-agent'

const strategies = ['off', 'summary', 'sliding_window', 'sticky_facts'] as const

describe('profile context instructions', () => {
  it.each(strategies)('keeps the complete profile instruction in the agent configuration for %s', (strategy) => {
    const profile = {
      id: '17a377c9-2c9c-46bb-8946-b3b331f1cd23',
      name: 'Учёба',
      revision: 2,
      defaultWorkflowId: null,
      instructions: 'Сначала дай короткий вывод.\nЗатем перечисли ограничения.',
    }
    const config = getAgentConfig(
      DEFAULT_COMPACTION_SETTINGS,
      { ...DEFAULT_CONTEXT_STRATEGY_SETTINGS, strategy },
      profile,
    )

    expect(config.profile).toEqual({ id: profile.id, revision: 2 })
    expect(config.instructions).toContain('Сначала дай короткий вывод.\nЗатем перечисли ограничения.')
    expect(config.instructionsHash).toBeTruthy()
  })
})
