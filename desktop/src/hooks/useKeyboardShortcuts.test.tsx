import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { APP_ZOOM_STORAGE_KEY } from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { useChatStore, type PerSessionState } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'

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

describe('useKeyboardShortcuts navigation', () => {
  const initialTabState = useTabStore.getInitialState()
  const initialUIState = useUIStore.getInitialState()

  function makeTabs(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      sessionId: `s${i + 1}`,
      title: `Session ${i + 1}`,
      type: 'session' as const,
      status: 'idle' as const,
    }))
  }

  function dispatch(init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    document.dispatchEvent(event)
    return event
  }

  afterEach(() => {
    cleanup()
    useTabStore.setState(initialTabState, true)
    useUIStore.setState(initialUIState, true)
  })

  it('jumps to the Nth session and treats 9 as the last one', () => {
    useTabStore.setState({ tabs: makeTabs(4), activeTabId: 's1' })
    render(<ShortcutHost />)

    dispatch({ code: 'Digit3', key: '3', metaKey: true })
    expect(useTabStore.getState().activeTabId).toBe('s3')

    dispatch({ code: 'Digit9', key: '9', metaKey: true })
    expect(useTabStore.getState().activeTabId).toBe('s4')
  })

  it('ignores a session index that has no open tab', () => {
    useTabStore.setState({ tabs: makeTabs(2), activeTabId: 's1' })
    render(<ShortcutHost />)

    const event = dispatch({ code: 'Digit5', key: '5', metaKey: true })

    expect(event.defaultPrevented).toBe(false)
    expect(useTabStore.getState().activeTabId).toBe('s1')
  })

  it('cycles sessions with Cmd+Shift+bracket and wraps at both ends', () => {
    useTabStore.setState({ tabs: makeTabs(3), activeTabId: 's1' })
    render(<ShortcutHost />)

    dispatch({ code: 'BracketLeft', key: '{', metaKey: true, shiftKey: true })
    expect(useTabStore.getState().activeTabId).toBe('s3')

    dispatch({ code: 'BracketRight', key: '}', metaKey: true, shiftKey: true })
    expect(useTabStore.getState().activeTabId).toBe('s1')
  })

  it('toggles the sidebar and opens settings', () => {
    const sidebarBefore = useUIStore.getState().sidebarOpen
    render(<ShortcutHost />)

    dispatch({ code: 'KeyB', key: 'b', metaKey: true })
    expect(useUIStore.getState().sidebarOpen).toBe(!sidebarBefore)

    dispatch({ code: 'Comma', key: ',', metaKey: true })
    const settingsTab = useTabStore.getState().tabs.find((t) => t.type === 'settings')
    expect(settingsTab).toBeDefined()
    expect(useTabStore.getState().activeTabId).toBe(settingsTab!.sessionId)
  })

  it('closes the active session tab and does nothing without one', () => {
    useTabStore.setState({ tabs: makeTabs(2), activeTabId: 's2' })
    render(<ShortcutHost />)

    dispatch({ code: 'KeyW', key: 'w', metaKey: true })
    expect(useTabStore.getState().tabs.map((t) => t.sessionId)).not.toContain('s2')

    useTabStore.setState({ tabs: [], activeTabId: null })
    const event = dispatch({ code: 'KeyW', key: 'w', metaKey: true })
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('useKeyboardShortcuts escape interrupt', () => {
  const sessionId = 'session-under-escape'
  const initialChatState = useChatStore.getInitialState()
  const initialTabState = useTabStore.getInitialState()
  const initialUIState = useUIStore.getInitialState()
  let stopGeneration: ReturnType<typeof vi.fn>

  function dispatchEscape(init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...init,
    })
    document.dispatchEvent(event)
    return event
  }

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
    useUIStore.setState(initialUIState, true)
  })

  it('interrupts a streaming session when no modal is open', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession({ chatState: 'streaming' }) },
    })
    render(<ShortcutHost />)

    const event = dispatchEscape()

    expect(event.defaultPrevented).toBe(true)
    expect(stopGeneration).toHaveBeenCalledWith(sessionId)
  })

  it('only closes the modal and leaves generation running', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession({ chatState: 'streaming' }) },
    })
    useUIStore.setState({ activeModal: 'globalSearch' })
    render(<ShortcutHost />)

    dispatchEscape()

    expect(useUIStore.getState().activeModal).toBeNull()
    expect(stopGeneration).not.toHaveBeenCalled()
  })

  it('does not interrupt when an inner surface already handled escape', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession({ chatState: 'streaming' }) },
    })
    render(<ShortcutHost />)

    const preventer = (event: KeyboardEvent) => event.preventDefault()
    document.addEventListener('keydown', preventer, true)
    try {
      dispatchEscape()
    } finally {
      document.removeEventListener('keydown', preventer, true)
    }

    expect(stopGeneration).not.toHaveBeenCalled()
  })

  it('does nothing when the session is idle with no background work', () => {
    useChatStore.setState({
      stopGeneration,
      sessions: { [sessionId]: makeIdleSession() },
    })
    render(<ShortcutHost />)

    const event = dispatchEscape()

    expect(event.defaultPrevented).toBe(false)
    expect(stopGeneration).not.toHaveBeenCalled()
  })
})
