import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Focus containment for the topmost dialog; nested dialogs keep their own Escape. */
export function useDialogFocus(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0)
    ;(dialog.querySelector<HTMLElement>('[data-sidebar-toggle]') ?? controls()[0] ?? dialog).focus()
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]')
      if (dialogs[dialogs.length - 1] !== dialog) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const items = controls()
      const first = items[0] ?? dialog
      const last = items.at(-1) ?? dialog
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected && previous.getClientRects().length > 0) previous.focus()
      else document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus()
    }
  }, [ref, open])
}
