import type { IconProps } from './icons/props.ts'
import piLogoSvg from '../../assets/pi-logo.svg?raw'

const piLogoUrl = `data:image/svg+xml,${encodeURIComponent(piLogoSvg)}`

/** The monochrome π mark shared by the sidebar and welcome screen. */
export function PiLogo({ size = 24, className }: IconProps) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: 'inline-block', flexShrink: 0, width: size, height: size,
        backgroundColor: 'currentColor',
        maskImage: `url("${piLogoUrl}")`, WebkitMaskImage: `url("${piLogoUrl}")`,
        maskSize: 'contain', WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center', WebkitMaskPosition: 'center',
      }}
    />
  )
}
