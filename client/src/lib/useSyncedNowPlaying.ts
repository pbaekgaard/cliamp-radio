import { useEffect, useRef, useState } from "react";
import type { WorkFmQueueItem } from "../api";
import { useRadioPlayer } from "../RadioPlayerContext";
import { useIcyTitleTimeline } from "./useIcyTitleTimeline";

/** Mirrors how the server derives its ICY `StreamTitle` for a queue item
 * (see workfmQueue.ts's `currentMetaString` assignments in loop()/
 * playSpecial()), so a boundary parsed off the stream can be matched back
 * to the poll payload it corresponds to. */
function metaStringFor(item: WorkFmQueueItem): string {
  return item.special ? item.title : `${item.artist} - ${item.title}`;
}

// How long a queued update is allowed to wait for its matching ICY boundary
// to become audible before it's shown anyway — guards against getting
// stuck forever if metadata parsing fails for some reason (an unsupported
// browser, a dropped connection, title text that doesn't round-trip through
// ICY framing) rather than silently freezing the "now playing" card.
const MAX_WAIT_MS = 20_000;

/**
 * Delays a WorkFM room's displayed "now playing" item until it's actually
 * about to be audible in *this* browser, instead of flipping the instant
 * the server's queue switches — which happens several seconds before the
 * new audio reaches any listener (server-side prebuffering, then the
 * browser's own network/decode buffering). See useIcyTitleTimeline's
 * comment for the full mechanism. Falls back to displaying immediately
 * whenever there's no way to measure the delay (not actually tuned in,
 * metadata parsing unavailable/failed, or the wait's simply taken too
 * long).
 */
export function useSyncedNowPlaying(
  pollNowPlaying: WorkFmQueueItem | null,
  playing: boolean,
  streamUrl: string
): WorkFmQueueItem | null {
  const { getAudioElement } = useRadioPlayer();
  const [displayed, setDisplayed] = useState<WorkFmQueueItem | null>(pollNowPlaying);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  const pendingRef = useRef<{ metaString: string; item: WorkFmQueueItem; queuedAt: number }[]>([]);
  const boundariesRef = useRef<{ title: string; atSec: number }[]>([]);
  const lastQueuedMetaStringRef = useRef<string | null>(pollNowPlaying ? metaStringFor(pollNowPlaying) : null);

  function check() {
    const audio = getAudioElement();
    const currentTime = audio?.currentTime ?? null;
    while (pendingRef.current.length > 0) {
      const next = pendingRef.current[0]!;
      const timedOut = Date.now() - next.queuedAt >= MAX_WAIT_MS;
      const boundaryIdx = boundariesRef.current.findIndex((b) => b.title === next.metaString);
      const boundary = boundaryIdx >= 0 ? boundariesRef.current[boundaryIdx] : null;
      const audible = boundary != null && currentTime !== null && currentTime >= boundary.atSec;
      if (!audible && !timedOut) break;
      pendingRef.current.shift();
      if (boundaryIdx >= 0) boundariesRef.current.splice(0, boundaryIdx + 1);
      setDisplayed(next.item);
    }
  }

  useIcyTitleTimeline(playing ? streamUrl : null, (boundary) => {
    boundariesRef.current.push(boundary);
    check();
  });

  // Re-checked on every playback tick (not just new boundaries) — a
  // boundary is typically parsed well before the audio actually reaches it.
  useEffect(() => {
    if (!playing) return;
    const audio = getAudioElement();
    if (!audio) return;
    audio.addEventListener("timeupdate", check);
    const id = setInterval(check, 1000); // covers any gaps between timeupdate events
    return () => {
      audio.removeEventListener("timeupdate", check);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    if (!playing) {
      // Not actually tuned in — nothing to measure the delay against, so
      // just mirror the poll directly and drop anything still queued.
      pendingRef.current = [];
      boundariesRef.current = [];
      lastQueuedMetaStringRef.current = pollNowPlaying ? metaStringFor(pollNowPlaying) : null;
      setDisplayed(pollNowPlaying);
      return;
    }
    if (!pollNowPlaying) {
      pendingRef.current = [];
      lastQueuedMetaStringRef.current = null;
      setDisplayed(null);
      return;
    }
    const metaString = metaStringFor(pollNowPlaying);
    if (metaString === lastQueuedMetaStringRef.current) {
      // Same track, just refreshed fields (likes, requested-by, vote
      // counts, ...) — update in place without re-queuing/re-delaying.
      if (displayedRef.current && metaStringFor(displayedRef.current) === metaString) setDisplayed(pollNowPlaying);
      return;
    }
    lastQueuedMetaStringRef.current = metaString;
    pendingRef.current.push({ metaString, item: pollNowPlaying, queuedAt: Date.now() });
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollNowPlaying, playing]);

  return displayed;
}
