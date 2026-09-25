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
//   2. The document title (tab title) — a much older, blunter mechanism
//      some very old/limited browsers fall back to for that same OS media
//      notification when Media Session isn't supported at all.
//
// Deliberately *not* both at once on a Media-Session-capable browser: doing
// so caused garbled/mashed-up car-stereo displays in practice (e.g.
// "ANNOUNCEMENT * CLIAMP...", "* deadmau5") — some Bluetooth/AVRCP bridges
// blend the ticking tab title into the same notification as the Media
// Session fields instead of picking one, once every few hundred ms as the
// ticker updates. So the tab-title ticker only runs as a genuine fallback,
// on browsers where `navigator.mediaSession` doesn't exist at all.
//
// That same garbled text turned out to have a second cause: `item` (the
// audio-synced now-playing item) is legitimately `null` for brief windows
// while still actively `playing` — e.g. the gap between two tracks, or
// while the server is streaming encoded filler silence because nothing's
// queued yet (see workfmQueue.ts's playSilence()). Chromium (and likely
// other browsers) don't just leave the OS media notification blank when
// `mediaSession.metadata` is null but the tab's audio is still flowing —
// they synthesize *fallback* metadata from the page's own <title> and
// origin instead. Nulling metadata during those transient gaps was exactly
// what produced the mashed-together "real track title/artist molded with
// the site's tab title" garbage reported from car Bluetooth displays and
// the desktop bar alike. So metadata is only ever cleared once `active`
// itself goes false (i.e. actually stopped/tuned out) — while still
// playing, a momentary lack of a synced item just leaves whatever
// metadata was last set in place rather than nulling it out.

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

    if (!active) {
      clearTicker();
      document.title = defaultTitle();
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      return;
    }

    if (!item) {
      // Still playing (e.g. a brief gap between tracks, or filler silence
      // with nothing queued yet) — deliberately leave the previous
      // metadata/title in place rather than nulling it. See the block
      // comment above for why nulling here caused the garbled displays.
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
