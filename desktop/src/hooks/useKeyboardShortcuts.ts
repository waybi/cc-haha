import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import {
  getAppZoomKeyboardAction,
  nextAppZoomLevel,
} from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { hasRunningSubagentTasks } from '../lib/backgroundTasks'
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

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [closeModal, openModal, openNewSession, setUiZoom, stopGeneration, toggleSidebar])
}
