import { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import {
  getAppZoomKeyboardAction,
  nextAppZoomLevel,
} from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { hasRunningSubagentTasks } from '../lib/backgroundTasks'

export function useKeyboardShortcuts() {
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeModal = useUIStore((s) => s.activeModal)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)
  const canStopActiveSession = useChatStore((s) => {
    const session = activeTabId ? s.sessions[activeTabId] : undefined
    return Boolean(
      session &&
      (session.chatState !== 'idle' || hasRunningSubagentTasks(session.backgroundAgentTasks)),
    )
  })
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const setUiZoom = useSettingsStore((s) => s.setUiZoom)

  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  const canStopActiveSessionRef = useRef(canStopActiveSession)
  canStopActiveSessionRef.current = canStopActiveSession
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const appZoomLevelRef = useRef(uiZoom)
  appZoomLevelRef.current = uiZoom


  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const zoomAction = getAppZoomKeyboardAction(e)
      if (zoomAction) {
        e.preventDefault()
        const nextZoom = nextAppZoomLevel(appZoomLevelRef.current, zoomAction)
        appZoomLevelRef.current = nextZoom
        setUiZoom(nextZoom)
        return
      }

      const meta = e.metaKey || e.ctrlKey

      // Cmd+N — New session
      if (meta && e.key === 'n') {
        e.preventDefault()
        setActiveSession(null)
        setActiveView('code')
      }

      // Cmd+B — Toggle the session sidebar
      if (meta && !e.shiftKey && !e.altKey && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }

      // Cmd+, — Open settings. Settings live in a dedicated tab, matching the
      // sidebar gear and the macOS native menu entry.
      if (meta && e.key === ',') {
        e.preventDefault()
        useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      }

      // Tab navigation reads the live store rather than a render-time snapshot,
      // so repeated presses within one render cycle still see the latest tabs.
      // Cmd+1..9 — Jump to the Nth open session (9 selects the last one,
      // matching the common browser/editor convention).
      if (meta && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const openTabs = useTabStore.getState().tabs
        if (openTabs.length > 0) {
          const requested = Number(e.code.slice(-1))
          const target = requested === 9 ? openTabs[openTabs.length - 1] : openTabs[requested - 1]
          if (target) {
            e.preventDefault()
            setActiveTab(target.sessionId)
          }
        }
      }

      // Cmd+Shift+[ / Cmd+Shift+] — Previous / next session, wrapping around
      if (meta && e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        const { tabs: openTabs, activeTabId: currentId } = useTabStore.getState()
        const current = openTabs.findIndex((t) => t.sessionId === currentId)
        if (openTabs.length > 1 && current !== -1) {
          e.preventDefault()
          const step = e.code === 'BracketLeft' ? -1 : 1
          const next = (current + step + openTabs.length) % openTabs.length
          setActiveTab(openTabs[next]!.sessionId)
        }
      }

      // Cmd+W — Close the active session tab
      if (meta && !e.shiftKey && e.key === 'w') {
        const currentId = useTabStore.getState().activeTabId
        if (currentId) {
          e.preventDefault()
          closeTab(currentId)
        }
      }

      // Cmd+K — Open global session search
      if (meta && e.key === 'k') {
        e.preventDefault()
        openModal('globalSearch')
      }

      // Ctrl+F — Open find-in-page bar
      if (meta && e.key === 'f') {
        e.preventDefault()
        openModal('findInPage')
      }

      // Escape — Close modal, otherwise interrupt the active session
      if (e.key === 'Escape') {
        if (activeModalRef.current) {
          closeModal()
          return
        }
        // Inner surfaces (slash menu, file search, popovers) mark their own
        // Escape handling as default-prevented; never interrupt on those.
        if (e.defaultPrevented) return
        if (canStopActiveSessionRef.current && activeTabIdRef.current) {
          e.preventDefault()
          stopGeneration(activeTabIdRef.current)
        }
      }

      // Cmd+. — Stop generation
      if (meta && e.key === '.') {
        if (canStopActiveSessionRef.current && activeTabIdRef.current) {
          e.preventDefault()
          stopGeneration(activeTabIdRef.current)
        }
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [
    closeModal,
    closeTab,
    openModal,
    setActiveSession,
    setActiveTab,
    setActiveView,
    setUiZoom,
    stopGeneration,
    toggleSidebar,
  ])
}
