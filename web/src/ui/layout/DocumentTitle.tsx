/** Keep the browser tab labeled with the product name. */
import { useEffect } from 'react'

export type DocumentTitleProps = {
  productTitle: string
}

export function DocumentTitle({ productTitle }: DocumentTitleProps): null {
  useEffect(() => {
    document.title = productTitle
    return () => { document.title = productTitle }
  }, [productTitle])
  return null
}
