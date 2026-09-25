import { useEffect, useRef } from "react";
import type { WorkFmQueueItem } from "../api";

// Browsers don't expose ICY "StreamTitle" metadata to page JS at all (it's
// stripped before the <audio> element ever sees it), so a car head unit or
// phone lock screen playing WorkFM *through the browser* (rather than a
// native ICY-aware player like mpv) has nothing to show unless the page
// itself hands over artist/title through browser-native channels instead:
//
//   1. The Media Session API (navigator.mediaSession.metadata) — the
//      correct, purpose-built mechanism. Chrome/Android relays this
//      straight into the OS media notification, which is what's mirrored
//      over Bluetooth AVRCP to a car stereo's display, and to the phone
//      lock screen. Safari/iOS supports it too.
//   2. The document title (tab title) — a much older, blunter mechanism,
//      but browsers that haven't picked up Media Session metadata yet (or
//      don't support it) commonly fall back to the tab title for that same
//      OS media notification. Scrolling it (ticker-style) is a classic
//      trick for getting a long "Artist - Title" to actually read in the
//      limited width that fallback gets rendered at.
//
// Both are updated here together, off the same synced now-playing item
// (see useSyncedNowPlaying) so neither drifts out of step with what's
// actually audible.

const TICKER_SEPARATOR = "   •   ";
const TICKER_INTERVAL_MS = 350;
const TICKER_MAX_LEN = 40; // enough to read comfortably in a browser tab

let capturedDefaultTitle: string | null = null;

/** The page's own <title> the first time this hook ever runs — restored
 * once nothing's playing (or this hook's caller unmounts) instead of
 * hard-coding a duplicate of index.html's title here. */
function defaultTitle(): string {
  if (capturedDefaultTitle === null) capturedDefaultTitle = document.title;
  return capturedDefaultTitle;
}

function metaFor(item: WorkFmQueueItem): { title: string; artist: string } {
  return item.special ? { title: item.title, artist: "Radio Bækgaard" } : { title: item.title, artist: item.artist };
}

/**
 * Keeps `navigator.mediaSession.metadata` and the tab title in sync with
 * `item` while `active` is true (typically: actually tuned in and playing),
 * so car/lock-screen "now playing" displays show the real artist/title
 * instead of nothing. Both are reset to their defaults whenever `active`
 * goes false or this hook unmounts.
 */
export function useNowPlayingMediaMetadata(item: WorkFmQueueItem | null, active: boolean) {
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function clearTicker() {
      if (tickerRef.current) {
        clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
    }

    if (!active || !item) {
      clearTicker();
      document.title = defaultTitle();
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      return;
    }

    const { title, artist } = metaFor(item);

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: "Radio Bækgaard" });
    }

    const text = `${artist} - ${title}`;
    if (text.length <= TICKER_MAX_LEN) {
      clearTicker();
      document.title = text;
    } else {
      const scroll = text + TICKER_SEPARATOR;
      let pos = 0;
      clearTicker();
      tickerRef.current = setInterval(() => {
        document.title = (scroll.slice(pos) + scroll.slice(0, pos)).slice(0, TICKER_MAX_LEN);
        pos = (pos + 1) % scroll.length;
      }, TICKER_INTERVAL_MS);
    }

    return clearTicker;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, item?.id, item?.artist, item?.title, item?.special]);

  // Always restore the real tab title on unmount, regardless of `active`.
  useEffect(() => {
    return () => {
      document.title = defaultTitle();
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
    };
  }, []);
}
