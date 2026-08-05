import { describe, expect, it } from 'vitest'

import {
  API_KEY_JSON_PLACEHOLDER,
  maskSettingsJsonSecrets,
  readUpstreamBaseUrlFromSettingsEnv,
  restoreSettingsJsonSecrets,
  stripProviderSettingsJsonEnv,
} from '../providerSettingsJson'

describe('provider settings JSON helpers', () => {
  it('masks both Anthropic API key env vars even when the values differ', () => {
    const raw = JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: 'stale-api-key',
        ANTHROPIC_AUTH_TOKEN: 'current-auth-token',
        OTHER_VALUE: 'visible',
      },
    })

    const masked = JSON.parse(maskSettingsJsonSecrets(raw)) as { env: Record<string, string> }

    expect(masked.env.ANTHROPIC_API_KEY).toBe(API_KEY_JSON_PLACEHOLDER)
    expect(masked.env.ANTHROPIC_AUTH_TOKEN).toBe(API_KEY_JSON_PLACEHOLDER)
    expect(masked.env.OTHER_VALUE).toBe('visible')
  })

  it('keeps cc-switch proxy-managed placeholders visible', () => {
    const raw = JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: 'PROXY_MANAGED',
        ANTHROPIC_AUTH_TOKEN: 'proxy-managed',
        OTHER_VALUE: 'visible',
      },
    })

    const masked = JSON.parse(maskSettingsJsonSecrets(raw)) as { env: Record<string, string> }

    expect(masked.env.ANTHROPIC_API_KEY).toBe('PROXY_MANAGED')
    expect(masked.env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-managed')
    expect(masked.env.OTHER_VALUE).toBe('visible')
  })

  it('restores masked Anthropic API key env vars from their previous field values', () => {
    const previousRaw = JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: 'previous-api-key',
        ANTHROPIC_AUTH_TOKEN: 'previous-auth-token',
      },
    })
    const edited = {
      env: {
        ANTHROPIC_API_KEY: API_KEY_JSON_PLACEHOLDER,
        ANTHROPIC_AUTH_TOKEN: API_KEY_JSON_PLACEHOLDER,
      },
    }

    const restored = restoreSettingsJsonSecrets(edited, previousRaw, 'fallback-key')

    expect(restored.env.ANTHROPIC_API_KEY).toBe('previous-api-key')
    expect(restored.env.ANTHROPIC_AUTH_TOKEN).toBe('previous-auth-token')
  })

  it('strips provider-managed env vars from existing settings before preview merge', () => {
    const cleaned = stripProviderSettingsJsonEnv(
      {
        ANTHROPIC_API_KEY: 'old-api-key',
        ANTHROPIC_AUTH_TOKEN: 'old-auth-token',
        ANTHROPIC_BASE_URL: 'https://old.example.com',
        ANTHROPIC_MODEL: 'old-model',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'old-fable',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Old Fable',
        CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: '{"old":100000}',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        CC_HAHA_OPENAI_OAUTH_PROVIDER: '1',
        OPENAI_CODEX_OAUTH_FILE: '/tmp/openai-oauth.json',
        CC_HAHA_SEND_DISABLED_THINKING: '1',
        USER_DEFINED: 'keep-me',
      },
      ['CC_HAHA_SEND_DISABLED_THINKING'],
    )

    expect(cleaned).toEqual({ USER_DEFINED: 'keep-me' })
  })

  it('keeps a real upstream base url from settings env', () => {
    expect(
      readUpstreamBaseUrlFromSettingsEnv(
        { ANTHROPIC_BASE_URL: 'http://127.0.0.1:61444' },
        'http://127.0.0.1:51091/proxy',
      ),
    ).toBe('http://127.0.0.1:61444')
  })

  it('refuses the local provider proxy url as an upstream base url', () => {
    for (const value of [
      'http://127.0.0.1:51091/proxy',
      'http://127.0.0.1:51091/proxy/',
      '  HTTP://127.0.0.1:51091/PROXY  ',
    ]) {
      expect(
        readUpstreamBaseUrlFromSettingsEnv({ ANTHROPIC_BASE_URL: value }, 'http://127.0.0.1:51091/proxy'),
      ).toBeNull()
    }
  })

  it('returns null when settings env carries no usable base url', () => {
    expect(readUpstreamBaseUrlFromSettingsEnv({}, 'http://127.0.0.1:51091/proxy')).toBeNull()
    expect(
      readUpstreamBaseUrlFromSettingsEnv({ ANTHROPIC_BASE_URL: '   ' }, 'http://127.0.0.1:51091/proxy'),
    ).toBeNull()
    expect(
      readUpstreamBaseUrlFromSettingsEnv({ ANTHROPIC_BASE_URL: 42 }, 'http://127.0.0.1:51091/proxy'),
    ).toBeNull()
  })
})
