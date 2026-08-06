import { useEffect } from 'react'
import type { ModelSelectorHandle } from '../components/controls/ModelSelector'

type ModelSelectorRef = { current: ModelSelectorHandle | null }

// The composer's model selector, reachable from the global keyboard shortcuts.
// Exactly one composer is mounted at a time (ContentRouter renders one page),
// so a single slot is enough. The *ref object* is stored rather than the handle
// itself: `useImperativeHandle` rebuilds the handle whenever its deps change,
// and a stored handle would go stale the moment it did.
let registered: ModelSelectorRef | null = null

export function getComposerModelSelector(): ModelSelectorHandle | null {
  return registered?.current ?? null
}

export function useRegisterComposerModelSelector(ref: ModelSelectorRef) {
  useEffect(() => {
    registered = ref
    // Only the current occupant may clear the slot. React commits the incoming
    // page's effects after the outgoing page's cleanup, but guarding the clear
    // keeps a stale unmount from blanking a live selector if that ever inverts.
    return () => {
      if (registered === ref) registered = null
    }
  }, [ref])
}
