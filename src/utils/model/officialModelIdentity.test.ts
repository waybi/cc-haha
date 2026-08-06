import { describe, expect, test } from 'bun:test'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
} from '../context.js'
import {
  CANONICAL_MODEL_IDS,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_5_CONFIG,
  CLAUDE_SONNET_5_CONFIG,
} from './configs.js'
import {
  firstPartyNameToCanonical,
  getMarketingNameForModel,
  getPublicModelDisplayName,
} from './model.js'

describe('official Claude model identity', () => {
  test('pins the canonical first-party model IDs', () => {
    expect(CLAUDE_OPUS_5_CONFIG.firstParty).toBe('claude-opus-5')
    expect(CLAUDE_OPUS_4_6_CONFIG.firstParty).toBe('claude-opus-4-6')
    expect(CLAUDE_SONNET_5_CONFIG.firstParty).toBe('claude-sonnet-5')
    expect(CANONICAL_MODEL_IDS).toContain('claude-opus-5')
  })

  test('normalizes provider-suffixed IDs to the canonical name', () => {
    expect(firstPartyNameToCanonical('claude-opus-5')).toBe('claude-opus-5')
    expect(
      firstPartyNameToCanonical('us.anthropic.claude-opus-4-6-v1:0'),
    ).toBe('claude-opus-4-6')
    expect(firstPartyNameToCanonical('us.anthropic.claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    )
  })

  test('does not infer Opus 5 from third-party or ambiguous IDs', () => {
    expect(firstPartyNameToCanonical('anthropic/claude-opus-5')).not.toBe(
      'claude-opus-5',
    )
    expect(firstPartyNameToCanonical('vendor/claude-opus-5-compatible')).not.toBe(
      'claude-opus-5',
    )
    expect(firstPartyNameToCanonical('claude-opus-50')).not.toBe('claude-opus-5')
    expect(getContextWindowForModel('anthropic/claude-opus-5')).toBe(200_000)
    expect(modelSupports1M('vendor/claude-opus-5-compatible')).toBe(false)
    expect(getModelMaxOutputTokens('vendor/claude-opus-5-compatible')).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    })
  })

  test('renders the current display names', () => {
    expect(getPublicModelDisplayName('claude-opus-5')).toBe('Opus 5')
    expect(getPublicModelDisplayName('claude-opus-5[1m]')).toBe(
      'Opus 5 (1M context)',
    )
    expect(getPublicModelDisplayName(CLAUDE_OPUS_4_6_CONFIG.firstParty)).toBe('Opus 4.6')
    expect(getPublicModelDisplayName(CLAUDE_SONNET_5_CONFIG.firstParty)).toBe('Sonnet 5')
    expect(getMarketingNameForModel('claude-opus-5[1m]')).toBe(
      'Opus 5 (with 1M context)',
    )
    expect(getMarketingNameForModel('claude-opus-4-6[1m]')).toBe(
      'Opus 4.6 (with 1M context)',
    )
    expect(getMarketingNameForModel('claude-sonnet-5[1m]')).toBe(
      'Sonnet 5 (with 1M context)',
    )
  })

  test('exposes a 1M context window for both models', () => {
    expect(modelSupports1M('claude-opus-5')).toBe(true)
    expect(getContextWindowForModel('claude-opus-5')).toBe(1_000_000)
    expect(modelSupports1M('claude-opus-4-6')).toBe(true)
    expect(getContextWindowForModel('claude-opus-4-6')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
    expect(getContextWindowForModel('anthropic/claude-sonnet-5')).toBe(
      1_000_000,
    )
  })

  test('uses the Opus 5 output-token limits', () => {
    expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
  })

  test('does not grant official Opus 5 limits to a custom Anthropic base URL', () => {
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    try {
      process.env.ANTHROPIC_BASE_URL =
        'https://provider.example.test/anthropic'
      expect(modelSupports1M('claude-opus-5')).toBe(false)
      expect(getContextWindowForModel('claude-opus-5')).toBe(200_000)
      expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({
        default: 32_000,
        upperLimit: 64_000,
      })
    } finally {
      if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
    }
  })
})
