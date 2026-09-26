/** Browser title selection follows the active main panel without subscribing the frame. */
import { useEffect } from 'react'
import type { AppFrameProps } from './AppFrame.tsx'

/** Props for the browser title projection. */
export type DocumentTitleProps = Pick<AppFrameProps, 'useSessions' | 'usePanelInfo'> & {
  /** Build-configured or localized product title. */
  productTitle: string
}

/**
 * Project the selected durable session title into the browser title and
 * restore the build-selected product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
export function DocumentTitle({ useSessions, usePanelInfo, productTitle }: DocumentTitleProps): null {
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions((state) => {
    const current = state.current
    return !showSessionTitle || current === undefined ? undefined : state.byId[current]?.title
  })
  useEffect(() => {
    document.title = title === undefined ? productTitle : `${title} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
