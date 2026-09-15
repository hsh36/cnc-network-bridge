/**
 * One drawing per operating mode.
 *
 * These are diagrams, not decoration: each shows where the wires go, because that is the
 * whole of what distinguishes the three modes. An operator standing in front of the
 * appliance can hold the picture against what is actually plugged in.
 *
 * Everything is stroked in `currentColor` with no fill. That is what makes them work in
 * both themes without a second set of assets — the card sets a text colour and the icon
 * follows it, including the accent colour when the card is the selected one. `aria-hidden`
 * because the card's own label and description already say what this is; a screen reader
 * announcing "diagram" twice adds nothing.
 */

const SVG_PROPS = {
  viewBox: '0 0 64 40',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/** The bridge itself: the same box in all three drawings, so the difference is the cabling. */
function BridgeBox({ x = 24, y = 14 }: { readonly x?: number; readonly y?: number }): JSX.Element {
  return (
    <>
      <rect x={x} y={y} width="16" height="12" rx="2" />
      <line x1={x + 4} y1={y + 8.5} x2={x + 12} y2={y + 8.5} />
    </>
  );
}

/** A control: a screen on a stand, recognisable at 40 px. */
function Machine({ x, y }: { readonly x: number; readonly y: number }): JSX.Element {
  return (
    <>
      <rect x={x} y={y} width="11" height="8" rx="1.5" />
      <line x1={x + 5.5} y1={y + 8} x2={x + 5.5} y2={y + 10} />
      <line x1={x + 2.5} y1={y + 10} x2={x + 8.5} y2={y + 10} />
    </>
  );
}

/** The server side: a stacked rack. */
function Server({ x, y }: { readonly x: number; readonly y: number }): JSX.Element {
  return (
    <>
      <rect x={x} y={y} width="11" height="5" rx="1" />
      <rect x={x} y={y + 6} width="11" height="5" rx="1" />
      <circle cx={x + 2.5} cy={y + 2.5} r="0.6" />
      <circle cx={x + 2.5} cy={y + 8.5} r="0.6" />
    </>
  );
}

/**
 * Mode 1 — one NIC on a trunk port, both segments as tagged VLANs.
 *
 * Drawn as a single cable carrying two tagged lanes, which is the thing that trips
 * people up: it is one wire, and the separation is the switch's job.
 */
export function VlanTrunkIcon({ className }: { readonly className?: string }): JSX.Element {
  return (
    <svg {...SVG_PROPS} className={className}>
      <Server x={3} y={8} />
      <Machine x={3} y={24} />
      <BridgeBox />
      {/* Both legs converge on one port, then run as a single trunk. */}
      <path d="M14 11 h6 q3 0 3 3 v4" />
      <path d="M14 29 h6 q3 0 3 -3 v-4" />
      <line x1="40" y1="20" x2="52" y2="20" />
      <rect x="52" y="14" width="9" height="12" rx="1.5" />
      {/* Two tags riding the one wire, which is the whole idea of a trunk. */}
      <circle cx="44" cy="20" r="1.6" />
      <circle cx="48" cy="20" r="1.6" />
    </svg>
  );
}

/**
 * Mode 2 — a NIC per side, several controls on one share.
 *
 * The fan-out on the machine side is the point: one share, many machines.
 */
export function DualNicServerIcon({ className }: { readonly className?: string }): JSX.Element {
  return (
    <svg {...SVG_PROPS} className={className}>
      <Server x={3} y={14} />
      <BridgeBox />
      <line x1="14" y1="20" x2="24" y2="20" />
      {/* One port on the machine side, branching to every control on the segment. */}
      <path d="M40 20 h5 q3 0 3 -3 v-6" />
      <path d="M40 20 h5 q3 0 3 3 v6" />
      <Machine x={48} y={3} />
      <Machine x={48} y={26} />
    </svg>
  );
}

/**
 * Mode 3 — a NIC per side, one bridged leg per control.
 *
 * Two separate paths through the box rather than a branch outside it, and a small
 * address tag on the machine side for the DHCP server this mode needs.
 */
export function DualNicBridgeIcon({ className }: { readonly className?: string }): JSX.Element {
  return (
    <svg {...SVG_PROPS} className={className}>
      <Server x={3} y={14} />
      <BridgeBox />
      <line x1="14" y1="20" x2="24" y2="20" />
      {/* Each machine gets its own path through the bridge, not a shared segment. */}
      <path d="M40 17 h4 q2 0 2 -2 v-4 q0 -2 2 -2 h2" />
      <path d="M40 23 h4 q2 0 2 2 v4 q0 2 2 2 h2" />
      <Machine x={50} y={3} />
      <Machine x={50} y={26} />
      {/* The address this mode hands out itself. */}
      <rect x="27" y="30" width="10" height="6" rx="1.5" />
      <line x1="29.5" y1="33" x2="34.5" y2="33" />
    </svg>
  );
}
