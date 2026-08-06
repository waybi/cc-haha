import { describe, expect, test } from 'bun:test'
import {
  COST_TIER_10_50,
  COST_TIER_5_25,
  getModelCosts,
  getModelPricingString,
} from './modelCost.js'

const baseUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
} as Parameters<typeof getModelCosts>[1]

describe('Opus 5 real-time pricing', () => {
  test('uses the standard 5/25 tier and publishes its pricing string', () => {
    expect(getModelCosts('claude-opus-5', baseUsage)).toEqual(COST_TIER_5_25)
    expect(getModelPricingString('claude-opus-5')).toBe('$5/$25 per Mtok')
  })

  test('uses the 10/50 tier for an actual fast-mode response', () => {
    expect(
      getModelCosts('claude-opus-5', {
        ...baseUsage,
        speed: 'fast',
      }),
    ).toEqual(COST_TIER_10_50)
  })
})
