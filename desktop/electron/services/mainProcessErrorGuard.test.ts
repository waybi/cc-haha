import { describe, expect, it } from 'vitest'
import {
  extractErrorCode,
  isTransientNetworkError,
} from './mainProcessErrorGuard'

describe('mainProcessErrorGuard', () => {
  it('detects ECONNRESET as transient network error', () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(isTransientNetworkError(error)).toBe(true)
    expect(extractErrorCode(error)).toBe('ECONNRESET')
  })

  it('detects message-only socket resets', () => {
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isTransientNetworkError(new Error('Client network socket disconnected before secure TLS connection was established'))).toBe(true)
  })

  it('does not swallow application bugs', () => {
    expect(isTransientNetworkError(new TypeError('Cannot read properties of undefined'))).toBe(false)
    expect(isTransientNetworkError(new Error('providers.json is invalid'))).toBe(false)
  })
})
