import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/traces', () => ({
  tracesApi: {
    list: vi.fn().mockResolvedValue({
      total: 0,
      storageDir: '/tmp/cc-haha/traces',
      settings: { enabled: true, storageDir: '/tmp/cc-haha/traces' },
      traces: [],
    }),
    deleteSession: vi.fn(),
  },
}))

import { Settings } from './Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

/**
 * The rail is a scroll container taller than its viewport, and Settings
 * remounts every time the tab is re-entered — notably when a trace tab's "back
 * to list" walks the user here. These cover the two halves of landing
 * correctly: the right section is shown, and its rail entry is in view.
 */
describe('Settings section navigation', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  })

  afterEach(() => {
    cleanup()
    scrollIntoView.mockClear()
    useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  })

  it('opens the section a pending request asked for and clears the request', async () => {
    useUIStore.setState({ pendingSettingsTab: 'trace' })

    render(<Settings />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Trace list' })).toBeInTheDocument()
    expect(useUIStore.getState().activeSettingsTab).toBe('trace')
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
  })

  it('brings the selected rail entry into view on mount', async () => {
    useUIStore.setState({ activeSettingsTab: 'trace' })

    render(<Settings />)

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })
    const railEntry = screen.getByRole('button', { name: 'Trace', current: 'page' })
    expect(railEntry).toBeInTheDocument()
  })

  it('follows the selection when another section is picked', () => {
    render(<Settings />)
    scrollIntoView.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(useUIStore.getState().activeSettingsTab).toBe('diagnostics')
  })
})
