import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface NowPlaying {
  url: string;
  label: string;
}

const VOLUME_STORAGE_KEY = "radioPlayerVolume";

function loadStoredVolume(): number {
  const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

interface RadioPlayerState {
  nowPlaying: NowPlaying | null;
  /** Toggles playback of `url` — pauses if it's already playing, otherwise switches to it. */
  toggle: (url: string, label: string) => void;
  /** Unconditionally (re)starts playback of `url`, unlike `toggle` — used
   * internally by `toggle` to begin a new stream. */
  play: (url: string, label: string) => void;
  stop: () => void;
  /** 0–1, local to this browser only — doesn't affect anyone else listening. */
  volume: number;
  setVolume: (volume: number) => void;
}

const RadioPlayerContext = createContext<RadioPlayerState | null>(null);

// How many times a dropped stream is retried (with backoff) before giving
// up and surfacing as "stopped" — live streams occasionally hiccup (a brief
// server-side stall while switching tracks, a network blip), and the
// <audio> element doesn't retry those on its own, it just goes silent.
// Self-healing here means a transient glitch doesn't force listeners to
// notice they've gone silent and manually re-press "Listen in".
const MAX_RECONNECT_ATTEMPTS = 6;

// A single shared <audio> element for every "Tune in" button across the
// site, so clicking a different station/channel stops whatever was playing
// instead of stacking multiple streams on top of each other — like an
// actual radio's tuning dial.
export function RadioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  // Mirrors `nowPlaying` for use inside the audio element's event handlers,
  // which close over stale state otherwise (the handlers are attached once
  // and never re-bound per render).
  const nowPlayingRef = useRef<NowPlaying | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [volume, setVolumeState] = useState(loadStoredVolume);
  const autoplayRetryArmedRef = useRef(false);

  useEffect(() => {
    nowPlayingRef.current = nowPlaying;
  }, [nowPlaying]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  function clearReconnect() {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;
  }

  // Browsers block audio.play() without a preceding user gesture (a click,
  // keypress, tap, etc. on the page) — silently rejecting the promise. Since
  // WorkFm auto-plays on mount with no dedicated "Listen live" button to
  // provide that gesture, a blocked attempt is retried the instant the
  // visitor interacts with the page at all (any click/keydown/touch), which
  // satisfies the browser's requirement without needing a dedicated button.
  function armAutoplayRetry() {
    if (autoplayRetryArmedRef.current) return;
    autoplayRetryArmedRef.current = true;
    const retry = () => {
      autoplayRetryArmedRef.current = false;
      document.removeEventListener("pointerdown", retry);
      document.removeEventListener("keydown", retry);
      const audio = audioRef.current;
      if (audio && nowPlayingRef.current) {
        audio.play().catch(() => {});
      }
    };
    document.addEventListener("pointerdown", retry, { once: true });
    document.addEventListener("keydown", retry, { once: true });
  }

  function play(url: string, label: string) {
    const audio = audioRef.current;
    if (!audio) return;
    clearReconnect();
    audio.src = url;
    audio.volume = volume;
    // Muted autoplay is unconditionally allowed by every major browser's
    // autoplay policy, unlike autoplay-with-sound (which requires a prior
    // user gesture or a high per-site "media engagement" score). Starting
    // muted then unmuting a moment later — once playback has actually begun
    // — sidesteps that restriction without needing a click, since the
    // policy is only enforced at the `.play()` call itself, not when a
    // already-playing element is later unmuted. If even the muted attempt
    // is blocked (rare), fall back to arming a gesture-triggered retry.
    audio.muted = true;
    audio
      .play()
      .then(() => {
        audio.muted = false;
      })
      .catch(() => armAutoplayRetry());
    setNowPlaying({ url, label });
  }

  function toggle(url: string, label: string) {
    if (nowPlayingRef.current?.url === url) {
      stop();
      return;
    }
    play(url, label);
  }

  function stop() {
    clearReconnect();
    // Set synchronously (not just via the effect above, which only runs on
    // the next render) so the `pause` event this triggers is recognized as
    // intentional by handlePause below, instead of being auto-resumed.
    nowPlayingRef.current = null;
    const audio = audioRef.current;
    if (audio) audio.pause();
    setNowPlaying(null);
  }

  /** This browser's playback volume only — everyone else keeps hearing the
   * stream at whatever level they've set for themselves. */
  function setVolume(next: number) {
    const clamped = Math.min(1, Math.max(0, next));
    setVolumeState(clamped);
    localStorage.setItem(VOLUME_STORAGE_KEY, String(clamped));
  }

  // Retries a dropped stream in place (same url/label) with a short
  // backoff, instead of immediately treating every glitch as "stopped".
  function handleDrop() {
    const current = nowPlayingRef.current;
    const audio = audioRef.current;
    if (!current || !audio) return; // stopped on purpose — nothing to recover
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      stop();
      return;
    }
    reconnectAttemptsRef.current += 1;
    const delay = Math.min(1000 * reconnectAttemptsRef.current, 4000);
    reconnectTimerRef.current = setTimeout(() => {
      const stillWanted = nowPlayingRef.current;
      if (!stillWanted || !audioRef.current) return;
      // Re-set src (not just .play()) so a stalled/broken fetch actually
      // reconnects from scratch rather than retrying the same dead one.
      audioRef.current.src = stillWanted.url;
      // Same muted-then-unmute fallback as the initial play() — a
      // reconnect can in principle hit the same autoplay restriction.
      audioRef.current.muted = true;
      audioRef.current
        .play()
        .then(() => {
          if (audioRef.current) audioRef.current.muted = false;
        })
        .catch(() => armAutoplayRetry());
    }, delay);
  }

  function handlePlaying() {
    reconnectAttemptsRef.current = 0;
  }

  // Some browsers silently pause long-running near-silent audio (e.g. the
  // WorkFM room idling between songs) to save power, without firing an
  // "error" or "ended" event — previously the only way to notice was the
  // listener realizing there's no sound and manually pressing pause/play
  // themselves. Any pause we didn't ask for (stop() nulls the ref *before*
  // pausing, precisely so it's excluded here) is resumed automatically.
  function handlePause() {
    const audio = audioRef.current;
    if (audio && nowPlayingRef.current) {
      audio.play().catch(() => armAutoplayRetry());
    }
  }

  return (
    <RadioPlayerContext.Provider value={{ nowPlaying, toggle, play, stop, volume, setVolume }}>
      {children}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        preload="none"
        onEnded={handleDrop}
        onError={handleDrop}
        onPlaying={handlePlaying}
        onPause={handlePause}
      />
    </RadioPlayerContext.Provider>
  );
}

export function useRadioPlayer() {
  const ctx = useContext(RadioPlayerContext);
  if (!ctx) throw new Error("useRadioPlayer must be used within RadioPlayerProvider");
  return ctx;
}
