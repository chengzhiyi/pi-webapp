/** A light drafting grid sits directly on the card, rather than inside a thumbnail frame. */
function DraftGrid() {
  return <path d="M9 12h156M9 20h156M9 28h156M9 36h156M9 44h156M9 52h156M9 60h156M9 68h156M9 76h156"
    stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray=".1 7.9" opacity=".2" />;
}

/** Decorative launcher artwork, not live document previews or substitutes for the plugin icons. */
export function DrawingArtwork() {
  return <svg viewBox="0 0 174 88" width="174" height="88" aria-hidden="true" fill="none">
    <DraftGrid />
    <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity=".62">
      <path d="M64 44h15a8 8 0 0 0 8-8v-6a8 8 0 0 1 8-8h15M79 44a8 8 0 0 1 8 8v6a8 8 0 0 0 8 8h15m-4-47 4 3-4 3m0 38 4 3-4 3" />
      <circle cx="79" cy="44" r="2.3" fill="var(--guide-paper)" />
    </g>
    <rect x="18" y="30" width="46" height="28" rx="7" fill="var(--guide-paper)" />
    <rect x="18.5" y="30.5" width="45" height="27" rx="6.5" stroke="currentColor" strokeOpacity=".54" />
    <circle cx="27" cy="44" r="2.3" fill="currentColor" fillOpacity=".7" />
    <path d="M34 41h20m-20 6h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeOpacity=".49" />
    <path d="M121 11h28a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-28a5 5 0 0 1-5-5V16a5 5 0 0 1 5-5Zm0 44h28a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-28a5 5 0 0 1-5-5V60a5 5 0 0 1 5-5Z" fill="currentColor" fillOpacity=".12" />
    <path d="M125 22h19m-19 44h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeOpacity=".49" />
  </svg>;
}

export function DesignArtwork() {
  return <svg viewBox="0 0 174 88" width="174" height="88" aria-hidden="true" fill="none">
    <DraftGrid />
    <path d="M39 19h105a6 6 0 0 1 6 6v45a6 6 0 0 1-6 6H39Z" fill="currentColor" fillOpacity=".1" />
    <rect x="24" y="11" width="113" height="62" rx="6" fill="var(--guide-paper)" />
    <rect x="24.5" y="11.5" width="112" height="61" rx="5.5" stroke="currentColor" strokeOpacity=".36" />
    <path d="M25 26h111" stroke="currentColor" strokeOpacity=".23" />
    <path d="M34 19h2m4 0h2m4 0h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeOpacity=".5" />
    <rect x="36" y="36" width="37" height="25" rx="1" fill="currentColor" fillOpacity=".12" stroke="currentColor" strokeOpacity=".6" />
    <path d="M34 34h4v4h-4zm37 0h4v4h-4zM34 59h4v4h-4zm37 0h4v4h-4z" fill="var(--guide-paper)" stroke="currentColor" strokeOpacity=".74" />
    <path d="M85 39h33m-33 7h40m-40 6h34m-34 6h20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeOpacity=".45" />
  </svg>;
}
