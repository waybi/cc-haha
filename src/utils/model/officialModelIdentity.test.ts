import { describe, expect, test } from 'bun:test'
import { getContextWindowForModel, modelSupports1M } from '../context.js'
import { CLAUDE_OPUS_4_6_CONFIG, CLAUDE_SONNET_5_CONFIG } from './configs.js'
import {
  firstPartyNameToCanonical,
  getMarketingNameForModel,
  getPublicModelDisplayName,
} from './model.js'

describe('official Claude model identity', () => {
  test('pins the canonical first-party model IDs', () => {
    expect(CLAUDE_OPUS_4_6_CONFIG.firstParty).toBe('claude-opus-4-6')
    expect(CLAUDE_SONNET_5_CONFIG.firstParty).toBe('claude-sonnet-5')
  })

  test('normalizes provider-suffixed IDs to the canonical name', () => {
    expect(
      firstPartyNameToCanonical('us.anthropic.claude-opus-4-6-v1:0'),
    ).toBe('claude-opus-4-6')
    expect(firstPartyNameToCanonical('us.anthropic.claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
  })

  test('renders the current display names', () => {
    expect(getPublicModelDisplayName(CLAUDE_OPUS_4_6_CONFIG.firstParty)).toBe('Opus 4.6')
    expect(getPublicModelDisplayName(CLAUDE_SONNET_5_CONFIG.firstParty)).toBe('Sonnet 5')
    expect(getMarketingNameForModel('claude-opus-4-6[1m]')).toBe(
      'Opus 4.6 (with 1M context)',
    )
    expect(getMarketingNameForModel('claude-sonnet-5[1m]')).toBe(
      'Sonnet 5 (with 1M context)',
    )
  })

  test('exposes a 1M context window for both models', () => {
    expect(modelSupports1M('claude-opus-4-6')).toBe(true)
    expect(getContextWindowForModel('claude-opus-4-6')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
    expect(getContextWindowForModel('anthropic/claude-sonnet-5')).toBe(
      1_000_000,
    )
  })
})
