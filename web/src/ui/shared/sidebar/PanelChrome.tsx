import type { ReactNode } from 'react'
import { Tooltip } from '../primitives/Tooltip.tsx'
import { IconPanelLeftOutlineRegular } from '../primitives/icons/index.tsx'
import type { DockMode } from '../dockkit/index.ts'
import css from './SidebarRight.module.css'

/** Expand-to-viewport glyph from the shared product artwork. */
function FullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.33203 10.4054V13.1681C2.33229 13.444 2.55605 13.6681 2.83203 13.6681H5.49512V14.6681H2.83203C2.00376 14.6681 1.33229 13.9963 1.33203 13.1681V10.4054H2.33203ZM14.6689 13.1681C14.6687 13.996 13.9968 14.6676 13.1689 14.6681H10.4951V13.6681H13.1689C13.4445 13.6676 13.6687 13.4437 13.6689 13.1681V10.4054H14.6689V13.1681ZM13.1689 1.33118C13.9969 1.33163 14.6688 2.00315 14.6689 2.83118V5.4054H13.6689V2.83118C13.6688 2.55544 13.4446 2.33162 13.1689 2.33118H10.4951V1.33118H13.1689ZM5.49512 2.33118H2.83203C2.55598 2.33118 2.33218 2.55516 2.33203 2.83118V5.4054H1.33203V2.83118C1.33218 2.00288 2.00369 1.33118 2.83203 1.33118H5.49512V2.33118Z" fill="currentColor" />
    </svg>
  )
}

/** Restore-from-fullscreen glyph from the shared product artwork. */
function ExitFullscreenGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9 2.5V6C9 6.26522 9.10536 6.51957 9.29289 6.70711C9.48043 6.89464 9.73478 7 10 7H13.5" stroke="currentColor" />
      <path d="M7 13.5V10C7 9.73478 6.89464 9.48043 6.70711 9.29289C6.51957 9.10536 6.26522 9 6 9H2.5" stroke="currentColor" />
    </svg>
  )
}

/** The panel's two controls, placed by the kit at the top-right pane's strip end. */
export function PanelChrome({ sessionId, fullscreen, actions, t, shortcuts, toggleFullscreen }: { sessionId: string; fullscreen: boolean; actions: { toggleExpanded(sessionId: string): void }; t: (key: string) => string; shortcuts: { id: string; aria: string; keys: readonly string[] }[]; toggleFullscreen(): void }): ReactNode {
  const next: DockMode = fullscreen ? 'push' : 'fullscreen'
  const modeLabel = fullscreen ? t('chrome.exitFullscreen') : t('chrome.toFullscreen')
  const mode = shortcuts.find(entry => entry.id === 'pane.fullscreen.toggle')
  const toggle = shortcuts.find(entry => entry.id === 'sidebar.right.toggle')
  return (
    <>
      <Tooltip label={modeLabel} shortcutKeys={mode?.keys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={modeLabel}
          aria-keyshortcuts={mode?.aria}
          data-sidebar-right-mode={next}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
        </button>
      </Tooltip>
      <Tooltip label={t('chrome.collapse')} shortcutKeys={toggle?.keys} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('chrome.collapseAria')}
          aria-keyshortcuts={toggle?.aria}
          data-sidebar-right-toggle
          onClick={() => { actions.toggleExpanded(sessionId) }}
        >
          <IconPanelLeftOutlineRegular className={css.collapseGlyph} />
        </button>
      </Tooltip>
    </>
  )
}
