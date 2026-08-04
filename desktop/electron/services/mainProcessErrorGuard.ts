import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_SSL_PROTOCOL_ERROR',
])

const TRANSIENT_NETWORK_MESSAGE =
  /ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|Connection reset|Client network socket disconnected|read ECONNRESET|write EPIPE/i

export type MainProcessErrorGuardOptions = {
  logFilePath?: string
  now?: () => Date
  onLog?: (line: string) => void
}

export function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.trim() ? code.trim() : null
}

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error'
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function isTransientNetworkError(error: unknown): boolean {
  const code = extractErrorCode(error)
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true

  const message = extractErrorMessage(error)
  if (TRANSIENT_NETWORK_MESSAGE.test(message)) return true

  const cause = error && typeof error === 'object'
    ? (error as { cause?: unknown }).cause
    : undefined
  if (cause && cause !== error) return isTransientNetworkError(cause)

  return false
}

function defaultLogFilePath(): string {
  return path.join(os.homedir(), '.claude', 'cc-haha', 'diagnostics', 'electron-main-errors.log')
}

function formatErrorLine(kind: string, error: unknown, now: Date): string {
  const code = extractErrorCode(error)
  const message = extractErrorMessage(error).replace(/\s+/g, ' ').slice(0, 1000)
  const stack = error instanceof Error && error.stack
    ? error.stack.split('\n').slice(0, 8).join(' | ').slice(0, 1500)
    : ''
  return `[${now.toISOString()}] ${kind} code=${code ?? '-'} message=${message}${stack ? ` stack=${stack}` : ''}\n`
}

export function logMainProcessError(
  kind: string,
  error: unknown,
  options: MainProcessErrorGuardOptions = {},
): void {
  const now = (options.now ?? (() => new Date()))()
  const line = formatErrorLine(kind, error, now)
  options.onLog?.(line)
  try {
    const logFilePath = options.logFilePath ?? defaultLogFilePath()
    mkdirSync(path.dirname(logFilePath), { recursive: true })
    appendFileSync(logFilePath, line, 'utf8')
  } catch {
    // Never let logging create a secondary crash path.
  }
  console.error(`[desktop] ${kind}:`, error)
}

/**
 * Install early so Electron's default "A JavaScript error occurred in the main
 * process" dialog does not fire for transient TCP resets (ECONNRESET/EPIPE/etc).
 * Fatal non-network exceptions still surface via the default dialog.
 */
export function installMainProcessErrorGuard(
  options: MainProcessErrorGuardOptions = {},
): () => void {
  const onUncaught = (error: Error) => {
    if (!isTransientNetworkError(error)) return
    logMainProcessError('uncaughtException.transient_network', error, options)
  }

  const onUnhandledRejection = (reason: unknown) => {
    if (!isTransientNetworkError(reason)) return
    logMainProcessError('unhandledRejection.transient_network', reason, options)
  }

  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandledRejection)

  return () => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onUnhandledRejection)
  }
}
