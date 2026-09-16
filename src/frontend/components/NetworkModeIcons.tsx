/**
 * One drawing per operating mode.
 *
 * These are diagrams, not decoration: each shows where the wires go, because that is the
 * whole of what distinguishes the two modes. An operator standing in front of the
 * appliance can hold the picture against what is actually plugged in.
 *
 * Only three things appear in them — the server, this bridge, and the controls. No
 * switch: whether there is one on the machine segment is not what the choice is about,
 * and drawing one made the left-hand mode look like it required particular hardware.
 * What it is about is how many controls are out there, so that is what differs.
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

/** The bridge itself: the same box in both drawings, so the difference is the cabling. */
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
 * Existing machine network — several controls share the segment.
 *
 * The bus with controls hanging off it is the point: this is a network that is already
 * there, and the bridge is one more thing on it.
 */
export function ExistingNetworkIcon({ className }: { readonly className?: string }): JSX.Element {
  return (
    <svg {...SVG_PROPS} className={className}>
      <Server x={3} y={14} />
      <BridgeBox />
      <line x1="14" y1="20" x2="24" y2="20" />
      {/* A run of cable down the machine side, with a drop to each control. */}
      <line x1="40" y1="20" x2="47" y2="20" />
      <line x1="47" y1="7" x2="47" y2="33" />
      <line x1="47" y1="7" x2="51" y2="7" />
      <line x1="47" y1="20" x2="51" y2="20" />
      <line x1="47" y1="33" x2="51" y2="33" />
      <Machine x={51} y={3} />
      <Machine x={51} y={16} />
      <Machine x={51} y={29} />
    </svg>
  );
}

/**
 * One machine on the bridge — no machine network at all.
 *
 * One cable and one control, drawn large enough that the difference from the diagram
 * beside it reads at a glance. The address tag is the DHCP server this mode needs:
 * there is nothing else on that segment to hand one out.
 */
export function SingleMachineIcon({ className }: { readonly className?: string }): JSX.Element {
  return (
    <svg {...SVG_PROPS} className={className}>
      <Server x={3} y={14} />
      <BridgeBox />
      <line x1="14" y1="20" x2="24" y2="20" />
      <line x1="40" y1="20" x2="49" y2="20" />
      <Machine x={49} y={15} />
      {/* The address this mode hands out itself. */}
      <rect x="27" y="30" width="10" height="6" rx="1.5" />
      <line x1="29.5" y1="33" x2="34.5" y2="33" />
    </svg>
  );
}
