/** Shared menu material and the macOS backing that lets Chromium blur transparent windows. */
import { forwardRef, useCallback, useContext, useId, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import css from './MenuSurface.module.css'
import { DialogFocusOwner, registerDialogFocusLayer } from '../../primitives/dialog-focus-scope.ts'

/** Menu containers preserve native div props and refs. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** Match the shared compact menu's smaller outer radius. */
  compact?: boolean
}

/**
 * Paint a menu and, on macOS, an opaque backing behind the page content within its bounds.
 * CSS anchors keep each backing aligned during placement, resizing, and nested-menu movement.
 * @param props - Div content and placement, and compact geometry.
 * @param ref - The visible menu div, excluding the non-interactive backing.
 * @returns Menu content plus a backing portal removed with the menu.
 */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  compact = false, className, style, children, ...props
}, ref) {
  const id = useId()
  const focusOwner = useContext(DialogFocusOwner)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const setSurfaceRef = useCallback((node: HTMLDivElement | null) => {
    surfaceRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }, [ref])
  useLayoutEffect(() => {
    if (surfaceRef.current && focusOwner) return registerDialogFocusLayer(surfaceRef.current, focusOwner)
  }, [focusOwner])
  const backingRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // Nested React portals can insert the backing before its anchor. CSS anchor
    // positioning requires the anchor to precede the positioned element.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- The portal ref is attached before layout effects run.
    document.body.appendChild(backingRef.current!)
  }, [])
  const anchorStyle: CSSProperties & { '--dsh-menu-anchor': string } = {
    '--dsh-menu-anchor': `--dsh-menu-${id.replaceAll(':', '')}`,
  }
  return <>
    <div {...props} ref={setSurfaceRef} data-menu-material="translucent"
      className={clsx(css.surface, compact && css.compact, className)} style={{ ...style, ...anchorStyle }}>
      <div aria-hidden="true" className={css.material} />
      {children}
    </div>
    {createPortal(
      <div ref={backingRef} aria-hidden="true" data-menu-backing="" className={clsx(css.backing, compact && css.compact)}
        style={{ ...anchorStyle, visibility: style?.visibility }} />,
      document.body,
    )}
  </>
})
