import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { WorkFmQueueItem } from "../api";

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Elapsed seconds for the now-playing track, ticked locally off
 * `startedAt` between queue polls so the progress bar animates smoothly
 * rather than jumping once every poll. */
function useElapsedSeconds(startedAt?: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  if (!startedAt) return 0;
  return Math.max(0, (now - startedAt) / 1000);
}

export function EqualizerBars() {
  return (
    <div className="kiosk-eq" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

/** Big animated "now playing" display — title, artist, a live progress bar,
 * and a bouncing equalizer — shared between the WorkFM room page and the
 * kiosk view (see WorkFmKiosk.tsx) so both show the exact same eye-catching
 * card instead of drifting apart over time. */
export function NowPlayingHero({
  item,
  emptyHint,
  controls,
  hint,
}: {
  item: WorkFmQueueItem | null;
  /** Subtitle shown under "Nothing playing yet" — callers tailor this to
   * where they're pointing people (e.g. "add a video below" vs a URL). */
  emptyHint?: string;
  /** Optional vote/action buttons rendered inside the card's own footer
   * slot. The slot always reserves the same amount of space (via CSS
   * min-height) whether or not it's given, so joining/leaving the room —
   * or switching between a normal track, an ad break, or an announcement —
   * never shifts the card's height or the layout below it. */
  controls?: ReactNode;
  /** Small note shown under the controls slot (e.g. "this track will
   * repeat"). Reserves its own line even when empty, for the same reason. */
  hint?: ReactNode;
}) {
  const elapsed = useElapsedSeconds(item?.startedAt);
  const duration = item?.durationSec ?? 0;
  const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  if (!item) {
    return (
      <div className="kiosk-hero kiosk-hero-empty">
        <div className="kiosk-hero-label">Now playing</div>
        <div className="kiosk-hero-title">Nothing playing yet</div>
        {emptyHint && <div className="kiosk-hero-sub">{emptyHint}</div>}
      </div>
    );
  }

  if (item.special) {
    return (
      <div className="kiosk-hero kiosk-hero-special">
        <div className="kiosk-hero-label">
          <EqualizerBars /> On air
        </div>
        <div className="kiosk-hero-title">{item.title}</div>
        {(controls !== undefined || hint !== undefined) && (
          <div className="kiosk-hero-footer">
            <div className="kiosk-hero-controls">{controls}</div>
            <div className="kiosk-hero-hint">{hint}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="kiosk-hero">
      <div className="kiosk-hero-label">
        <EqualizerBars /> Now playing
      </div>
      <div className="kiosk-hero-title">{item.title}</div>
      <div className="kiosk-hero-artist">{item.artist}</div>
      <div className="kiosk-hero-meta">
        {item.addedBy === "Auto DJ" ? (
          <strong className="kiosk-hero-autodj">Auto DJ</strong>
        ) : (
          <>
            requested by <strong>{item.addedBy}</strong>
          </>
        )}
        {item.likes > 0 && <span className="kiosk-hero-likes"> · ♥ {item.likes}</span>}
      </div>
      {duration > 0 && (
        <div className="kiosk-progress">
          <div className="kiosk-progress-track">
            <div className="kiosk-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="kiosk-progress-time muted">
            {formatClock(elapsed)} / {formatClock(duration)}
          </div>
        </div>
      )}
      {(controls !== undefined || hint !== undefined) && (
        <div className="kiosk-hero-footer">
          <div className="kiosk-hero-controls">{controls}</div>
          <div className="kiosk-hero-hint">{hint}</div>
        </div>
      )}
    </div>
  );
}
