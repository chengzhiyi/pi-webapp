import type { IconProps } from './icons/props.ts'
import piLogoSvg from '../../assets/pi-logo.svg?raw'

const piLogoUrl = `data:image/svg+xml,${encodeURIComponent(piLogoSvg)}`

/** The monochrome π mark shared by the sidebar and welcome screen. */
export function PiLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src={piLogoUrl}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
    />
  )
}
