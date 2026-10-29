import { createContext, type RefObject } from 'react'

/** React ownership follows portals even when their DOM lives outside a dialog. */
export const DialogFocusOwner = createContext<RefObject<HTMLElement> | null>(null)
const layers = new Map<HTMLElement, RefObject<HTMLElement>>()

export function registerDialogFocusLayer(layer: HTMLElement, owner: RefObject<HTMLElement>) {
  layers.set(layer, owner)
  return () => { layers.delete(layer) }
}

export function withinDialogFocusScope(dialog: HTMLElement, target: Node | null) {
  if (!target) return false
  if (dialog.contains(target)) return true
  for (const [layer, owner] of layers) {
    if (owner.current === dialog && layer.isConnected && layer.contains(target)) return true
  }
  return false
}
