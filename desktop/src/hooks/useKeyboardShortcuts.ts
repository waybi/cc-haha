import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { isSessionTabId, useTabStore } from '../stores/tabStore'
import { useTerminalPanelStore } from '../stores/terminalPanelStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacePanelStore } from '../stores/workspacePanelStore'
import {
  getAppZoomKeyboardAction,
  nextAppZoomLevel,
} from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { hasRunningSubagentTasks } from '../lib/backgroundTasks'
import { getComposerModelSelector } from '../lib/composerModelSelector'
import { useTranslation } from '../i18n'

export function useKeyboardShortcuts() {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeModal = useUIStore((s) => s.activeModal)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const canStopActiveSession = useChatStore((s) => {
    const session = activeTabId ? s.sessions[activeTabId] : undefined
    return Boolean(
      session &&
      (session.chatState !== 'idle' || hasRunningSubagentTasks(session.backgroundAgentTasks)),
    )
  })
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const setUiZoom = useSettingsStore((s) => s.setUiZoom)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)

  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  const canStopActiveSessionRef = useRef(canStopActiveSession)
  canStopActiveSessionRef.current = canStopActiveSession
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const appZoomLevelRef = useRef(uiZoom)
  appZoomLevelRef.current = uiZoom

  // Mirrors the sidebar's "New session" action: a session only exists once it
  // has a tab and a live connection, so setting an active id is not enough.
  const openNewSession = useCallback(async () => {
    const tabStore = useTabStore.getState()
    const sessionStore = useSessionStore.getState()
    const currentSession = tabStore.activeTabId
      ? sessionStore.sessions.find((session) => session.id === tabStore.activeTabId)
      : null
    try {
      const sessionId = await sessionStore.createSession(
        currentSession?.workDir || currentSession?.projectRoot || undefined,
      )
      tabStore.openTab(sessionId, t('sidebar.newSession'))
      useChatStore.getState().connectToSession(sessionId)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.sessionListFailed'),
      })
    }
  }, [addToast, t])

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
        void openNewSession()
      }

      // Cmd+B — Toggle sidebar
      if (meta && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      }

      // Ctrl+` — Toggle the terminal, mirroring the tab bar's terminal button.
      // Ctrl and not Cmd even on macOS: Cmd+` is the system's window cycler.
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault()
        const activeTabId = activeTabIdRef.current
        if (isSessionTabId(activeTabId)) {
          useTerminalPanelStore.getState().togglePanel(activeTabId)
        } else {
          useTabStore.getState().openTerminalTab()
        }
        return
      }

      // Cmd+Shift+E — Toggle the workspace file panel, mirroring the tab bar's
      // folder button. Only session tabs have one, same as the button itself.
      if (meta && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        const activeTabId = activeTabIdRef.current
        if (isSessionTabId(activeTabId)) {
          const workspace = useWorkspacePanelStore.getState()
          if (workspace.isPanelOpen(activeTabId) && workspace.getMode(activeTabId) === 'workspace') {
            workspace.closePanel(activeTabId)
          } else {
            workspace.setMode(activeTabId, 'workspace')
            workspace.openPanel(activeTabId)
          }
        }
        return
      }

      // Cmd+Shift+A — Open the composer's model picker
      if (meta && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        getComposerModelSelector()?.open()
        return
      }

      // Cmd+Shift+R — Open the reasoning effort slider. Silently does nothing
      // when the selected model has no effort levels, same as the button that
      // opens it: it is not rendered at all in that case.
      if (meta && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        getComposerModelSelector()?.openEffort()
        return
      }

      // Cmd+K — Open global session search
      if (meta && e.key === 'k') {
        e.preventDefault()
        openModal('globalSearch')
      }

      // Cmd+F — Open find-in-page bar
      if (meta && e.key === 'f') {
        e.preventDefault()
        openModal('findInPage')
      }

      // Escape — Close the modal, or stop generation when nothing is layered on top.
      // `defaultPrevented` means a closer handler (the composer's slash/file
      // menus) already consumed the key, so Escape stays a "dismiss" there.
      if (e.key === 'Escape') {
        if (activeModalRef.current) {
          closeModal()
          return
        }
        if (!e.defaultPrevented && canStopActiveSessionRef.current && activeTabIdRef.current) {
          e.preventDefault()
          stopGeneration(activeTabIdRef.current)
        }
        return
      }

      // Cmd+. — Stop generation
      if (meta && e.key === '.') {
        if (canStopActiveSessionRef.current && activeTabIdRef.current) {
          e.preventDefault()
          stopGeneration(activeTabIdRef.current)
        }
      }
    }

    // On `window`, not `document`: overlays register their own Escape handlers
    // on `document` only once opened, so they always sort after this hook's
    // listener there and the `defaultPrevented` check below would never see
    // their dismissal. `window` is the last bubble target, so it does.
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeModal, openModal, openNewSession, setUiZoom, stopGeneration, toggleSidebar])
}
