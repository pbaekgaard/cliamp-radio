/** "S" + n U's + "LT" — several marquee rows use this so the screen doesn't
 * read as one word repeated identically, mixed in with the other stretched
 * exclamations below. */
function suult(uCount: number): string {
  return `S${"U".repeat(uCount)}LT`;
}

/** "SP" + n I's + "SE" — e.g. spiise(4) => "SPIIIISE". */
function spiise(iCount: number): string {
  return `SP${"I".repeat(iCount)}SE`;
}

/** "M" + n A's + "D" — e.g. maaad(4) => "MAAAAD". */
function maaad(aCount: number): string {
  return `M${"A".repeat(aCount)}D`;
}

/** "GUMLET" + n I's + "D" — e.g. gumletiiid(4) => "GUMLETIIIID". */
function gumletiiid(iCount: number): string {
  return `GUMLET${"I".repeat(iCount)}D`;
}

// Fixed (not random) row layout — 14 rows is comfortably more than the "at
// least 5 in view at all times" ask, spread across the full height, at
// varied words/speeds/directions so it doesn't feel like one looping gif.
// Each row sweeps the *entire* viewport width every animation cycle (see
// the spisetid-marquee-ltr/-rtl keyframes' -120vw/120vw endpoints), so with
// a negative animation-delay spreading the rows evenly across their own
// duration, every row is somewhere on-screen essentially all the time.
const MARQUEE_ROWS = [
  { text: suult(3), top: "2%", duration: 16, direction: "ltr" as const },
  { text: maaad(3), top: "9%", duration: 12, direction: "rtl" as const },
  { text: suult(9), top: "16%", duration: 21, direction: "ltr" as const },
  { text: spiise(2), top: "23%", duration: 14, direction: "rtl" as const },
  { text: suult(5), top: "30%", duration: 13, direction: "ltr" as const },
  { text: gumletiiid(3), top: "37%", duration: 19, direction: "rtl" as const },
  { text: suult(12), top: "44%", duration: 24, direction: "ltr" as const },
  { text: "NAMMENAM", top: "51%", duration: 15, direction: "rtl" as const },
  { text: maaad(8), top: "58%", duration: 17, direction: "ltr" as const },
  { text: suult(4), top: "65%", duration: 18, direction: "ltr" as const },
  { text: spiise(6), top: "72%", duration: 16, direction: "rtl" as const },
  { text: "MMMMHHHHHHHHH", top: "79%", duration: 20, direction: "rtl" as const },
  { text: gumletiiid(7), top: "86%", duration: 15, direction: "ltr" as const },
  { text: suult(7), top: "93%", duration: 22, direction: "rtl" as const },
];

/**
 * Full-screen alarm overlay shown on both the WorkFM room page and the
 * kiosk view whenever the stream's now-playing item is the spisetid
 * (lunch-break) special — see server/lib/workfmQueue.ts's runSpiseTid().
 * Dims the whole page (not just the now-playing card) so it's unmissable
 * from across the room, and disappears the instant the server moves on to
 * the next real/auto-DJ track (special stops being "spisetid") — same
 * polling-driven mechanism as everything else here, no extra plumbing
 * needed.
 *
 * Layered back-to-front: the scrolling marquee rows (stretched-out variants
 * of "SUUUUUULT"/"SPIIIISE"/"MAAAAD"/"GUMLETIIIID" with varying vowel
 * counts, plus other Danish lunch-alarm exclamations) sit at the very back,
 * a solid black dim layer sits on top of *those* (so the marquee reads as
 * muted background noise, not a competing focal point), and the crisp,
 * undimmed "SPISETID" centerpiece sits above everything.
 */
export function SpiseTidOverlay({
  active,
  children,
}: {
  active: boolean;
  /** Rendered below the SPISETID centerpiece — used by the WorkFM room
   * page to keep chat usable during the lunch break, without giving the
   * (deliberately chat-less) kiosk display the same treatment. */
  children?: React.ReactNode;
}) {
  if (!active) return null;
  return (
    <div className="spisetid-overlay" role="alert" aria-live="assertive">
      <div className="spisetid-marquee-layer" aria-hidden="true">
        {MARQUEE_ROWS.map((row, i) => (
          <div
            key={i}
            className={`spisetid-marquee-row spisetid-marquee-${row.direction}`}
            style={{
              top: row.top,
              animationDuration: `${row.duration}s`,
              animationDelay: `${-(i * row.duration) / MARQUEE_ROWS.length}s`,
            }}
          >
            {row.text}
          </div>
        ))}
      </div>
      <div className="spisetid-dim-layer" aria-hidden="true" />
      <div className="spisetid-overlay-content">
        <div className="spisetid-overlay-text">SPISETID</div>
        <div className="spisetid-overlay-sub">Radio Bækgaard er på frokostpause</div>
        {children && <div className="spisetid-overlay-chat">{children}</div>}
      </div>
    </div>
  );
}
