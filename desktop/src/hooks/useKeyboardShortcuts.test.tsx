import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { APP_ZOOM_STORAGE_KEY } from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { useChatStore, type PerSessionState } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useSessionStore } from '../stores/sessionStore'

function ShortcutHost() {
  useKeyboardShortcuts()
  return null
}

function setNavigatorPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  })
}

function makeIdleSession(overrides: Partial<PerSessionState> = {}): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    elapsedTimer: null,
    ...overrides,
  }
}

describe('useKeyboardShortcuts app zoom', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-mode')
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
    useSettingsStore.setState({ uiZoom: 1 })
    setNavigatorPlatform('Win32')
  })

  afterEach(() => {
    cleanup()
  })

  it('handles Ctrl zoom shortcuts on Windows and Linux style platforms', async () => {
    render(<ShortcutHost />)

    fireEvent.keyDown(document, {
      code: 'Equal',
      ctrlKey: true,
      key: '=',
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.1')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1.1)
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('110')

    fireEvent.keyDown(document, {
      code: 'Minus',
      ctrlKey: true,
      key: '-',
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1)

    fireEvent.keyDown(document, {
      code: 'NumpadAdd',
      ctrlKey: true,
      key: '+',
    })
    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.1')
    })

    fireEvent.keyDown(document, {
      code: 'Digit0',
      ctrlKey: true,
      key: '0',
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1')
    })
  })

  it('uses Cmd zoom shortcuts on macOS', async () => {
    setNavigatorPlatform('MacIntel')
    render(<ShortcutHost />)

    fireEvent.keyDown(document, {
      code: 'Minus',
      key: '-',
      metaKey: true,
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('0.9')
    })

    fireEvent.keyDown(document, {
      code: 'Equal',
      ctrlKey: true,
      key: '=',
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('0.9')
  })
})

describe('useKeyboardShortcuts new session', () => {
  const sessionId = 'current-session'
  const initialChatState = useChatStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialSessionState = useSessionStore.getInitialState()

  afterEach(() => {
    cleanup()
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
    useSessionStore.setState(initialSessionState, true)
  })

  it('opens and connects a tab for the session Cmd+N creates', async () => {
    const createSession = vi.fn().mockResolvedValue('created-session')
    const connectToSession = vi.fn()
    useSessionStore.setState({
      createSession,
      sessions: [{ id: sessionId, workDir: '/repo' } as never],
    })
    useChatStore.setState({ connectToSession })
    useTabStore.setState({
      activeTabId: sessionId,
      tabs: [{ sessionId, title: 'Session', type: 'session', status: 'idle' }],
    })
    render(<ShortcutHost />)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }))

    await waitFor(() => {
      expect(connectToSession).toHaveBeenCalledWith('created-session')
    })
    expect(createSession).toHaveBeenCalledWith('/repo')
    expect(useTabStore.getState().activeTabId).toBe('created-session')
    expect(useTabStore.getState().tabs.some((tab) => tab.sessionId === 'created-session')).toBe(true)
  })
})

describe('useKeyboardShortcuts generation stop', () => {
  const sessionId = 'session-with-background-work'
  const initialChatState = useChatStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  let stopGeneration: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stopGeneration = vi.fn()
    useTabStore.setState({
      activeTabId: sessionId,
      tabs: [{ sessionId, title: 'Session', type: 'session', status: 'running' }],
    })
  })

  afterEach(() => {
    cleanup()
    useChatStore.setState(initialChatState, true)
    useTabStore.setState(initialTabState, true)
    useUIStore.setState({ activeModal: null })
  })

  it.each([
    ['Cmd', 'local_agent', { metaKey: true }],
    ['Ctrl', 'remote_agent', { ctrlKey: true }],
  ] as const)('uses %s+. to stop an idle session with a running %s', (_label, taskType, modifier) => {
    useChatStore.setState({
      stopGeneration,
      sessions: {
        [sessionId]: makeIdleSession({
          backgroundAgentTasks: {
            agent: {
              taskId: 'agent',
              taskType,
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
        }),
      },
    })
    render(<ShortcutHost />)

    const event = new KeyboardEvent('keydown', {
      key: '.',
      bubbles: true,
      cancelable: true,
      ...modifier,
    })
    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(stopGeneration).toHaveBeenCalledWith(sessionId)
  })

  it('uses Escape to stop a generating session', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession({ chatState: 'streaming' }) },
    })
    render(<ShortcutHost />)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)

    expect(stopGeneration).toHaveBeenCalledWith(sessionId)
  })

  it('leaves Escape to the composer menus that already consumed it', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession({ chatState: 'streaming' }) },
    })
    render(<ShortcutHost />)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    document.dispatchEvent(event)

    expect(stopGeneration).not.toHaveBeenCalled()
  })

  it('closes an open modal with Escape instead of stopping generation', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession({ chatState: 'streaming' }) },
    })
    useUIStore.setState({ activeModal: 'globalSearch' })
    render(<ShortcutHost />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(stopGeneration).not.toHaveBeenCalled()
    expect(useUIStore.getState().activeModal).toBeNull()
  })

  it.each(['local_bash', 'dream'])('does not stop an idle session for a running %s task', (taskType) => {
    useChatStore.setState({
      stopGeneration,
      sessions: {
        [sessionId]: makeIdleSession({
          backgroundAgentTasks: {
            task: {
              taskId: 'task',
              taskType,
              status: 'running',
              startedAt: 1,
              updatedAt: 1,
            },
          },
        }),
      },
    })
    render(<ShortcutHost />)

    const event = new KeyboardEvent('keydown', {
      key: '.',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(stopGeneration).not.toHaveBeenCalled()
  })
})
