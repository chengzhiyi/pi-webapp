/** Shared artwork for the plugin manager and workspace entry. */
export function ExcalidrawIcon({ size = 24 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: "block", flexShrink: 0 }}>
    <path d="m14.5 4.5 5 5M4 20l5.3-1.3L20 8a2.8 2.8 0 0 0-4-4L5.3 14.7 4 20Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m5.5 14.5 4 4M8 15l8-8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>;
}
