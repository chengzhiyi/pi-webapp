/**
 * OpenPencil mark for the plugin manager and workspace entry: a vector path with its anchor points and
 * one Bézier handle (a design tool), kept apart from Excalidraw's hand-drawn pencil.
 */
export function OpenPencilIcon({ size = 24 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: "block", flexShrink: 0 }}>
    <path d="M5 19C5 11 10 6 18 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M18 6h-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <rect x="3" y="17" width="4" height="4" rx="0.8" fill="currentColor" />
    <rect x="16" y="4" width="4" height="4" rx="0.8" fill="currentColor" />
    <circle cx="10.5" cy="6" r="1.5" fill="currentColor" />
  </svg>;
}
