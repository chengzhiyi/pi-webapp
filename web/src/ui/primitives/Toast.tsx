// One app-wide stack for transient failures, so errors never wedge themselves into the
// layout where they happened. Toasts float over the page, so they clear themselves:
// hovering holds one open, and a toast offering a recovery action waits for the user.

import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import css from './Toast.module.css'

export type ToastTone = 'error' | 'info'

export interface ToastInput {
  /** Stable identity: re-showing the same key replaces the toast instead of stacking duplicates. */
  key?: string
  tone?: ToastTone
  /** Short, user-facing sentence. */
  message: string
  /** Raw diagnostic text, shown collapsed under the message. */
  detail?: string
  detailLabel?: string
  /** One recovery step; running it dismisses the toast. */
  action?: { label: string; onClick: () => void }
}

interface Toast extends Required<Pick<ToastInput, 'key' | 'tone' | 'message'>> { detail?: string; detailLabel?: string; action?: ToastInput['action'] }

const INFO_MS = 4000
const ERROR_MS = 8000
let toasts: readonly Toast[] = []
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
let counter = 0

function emit(next: readonly Toast[]) { toasts = next; for (const listener of listeners) listener() }

/** Show (or replace by key) a toast; returns its key. */
export function showToast(input: ToastInput): string {
  const key = input.key ?? `toast-${++counter}`
  const toast: Toast = { key, tone: input.tone ?? 'error', message: input.message, detail: input.detail, detailLabel: input.detailLabel, action: input.action }
  emit([...toasts.filter(item => item.key !== key), toast].slice(-4))
  holdToast(key); releaseToast(key)
  return key
}

function holdToast(key: string) { clearTimeout(timers.get(key)); timers.delete(key) }

function releaseToast(key: string) {
  const toast = toasts.find(item => item.key === key)
  if (!toast || toast.action) return
  timers.set(key, setTimeout(() => dismissToast(key), toast.tone === 'info' ? INFO_MS : ERROR_MS))
}

export function dismissToast(key: string) {
  holdToast(key)
  if (toasts.some(item => item.key === key)) emit(toasts.filter(item => item.key !== key))
}

/** Raise an error toast whenever `message` changes to a new non-empty value. */
export function useErrorToast(key: string, message: string | null | undefined, detail?: string, detailLabel?: string) {
  useEffect(() => { if (message) showToast({ key, message, detail: detail && detail !== message ? detail : undefined, detailLabel }) }, [key, message, detail, detailLabel])
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => toasts

/** Mount once at the app root. */
export function ToastViewport({ closeLabel = 'Dismiss', detailLabel = 'Details' }: { closeLabel?: string; detailLabel?: string }) {
  const items = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (typeof document === 'undefined') return null
  return createPortal(<div className={css.viewport} data-toast-viewport>
    {items.map(item => <div key={item.key} className={css.toast} data-tone={item.tone} role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => holdToast(item.key)} onMouseLeave={() => releaseToast(item.key)}>
      <div className={css.body}>
        <p className={css.message}>{item.message}</p>
        {item.detail && <details className={css.detail}><summary>{item.detailLabel ?? detailLabel}</summary><pre>{item.detail}</pre></details>}
        {item.action && <button type="button" className={css.action} onClick={() => { dismissToast(item.key); item.action!.onClick() }}>{item.action.label}</button>}
      </div>
      <button type="button" className={css.close} aria-label={closeLabel} onClick={() => dismissToast(item.key)}>×</button>
    </div>)}
  </div>, document.body)
}
