import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface NowPlaying {
  url: string;
  label: string;
  /** Set when this NowPlaying is being played through the low-latency
   * WebSocket+PCM engine (see playLowLatency()/connectLowLatency() below)
   * instead of the shared `<audio>` element — WorkFM's own room slug in
   * that case. Absent for every other (plain HTTP MP3/ICY) station. */
  lowLatencySlug?: string;
}

const VOLUME_STORAGE_KEY = "radioPlayerVolume";

function loadStoredVolume(): number {
  const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

/** Options accepted by play()/toggle() to route playback through the
 * low-latency engine instead of the default HTTP MP3/ICY `<audio>` path —
 * see WorkFm.tsx, the only current caller. */
interface PlayOpts {
  lowLatencySlug?: string;
}

interface RadioPlayerState {
  nowPlaying: NowPlaying | null;
  /** Toggles playback of `url` — pauses if it's already playing, otherwise switches to it. */
  toggle: (url: string, label: string, opts?: PlayOpts) => void;
  /** Unconditionally (re)starts playback of `url`, unlike `toggle` — used
   * internally by `toggle` to begin a new stream. */
  play: (url: string, label: string, opts?: PlayOpts) => void;
  stop: () => void;
  /** 0–1, local to this browser only — doesn't affect anyone else listening. */
  volume: number;
  setVolume: (volume: number) => void;
  /** The single shared `<audio>` element, or null before mount — read-only
   * escape hatch for callers that need to read `.currentTime`/listen for
   * `timeupdate` to line up something with what's actually audible right
   * now. Only meaningful while the *plain HTTP* path is active (`nowPlaying`
   * has no `lowLatencySlug`) — the low-latency engine doesn't use this
   * element at all. Not meant for controlling playback directly — use
   * play()/toggle()/stop(). */
  getAudioElement: () => HTMLAudioElement | null;
}

const RadioPlayerContext = createContext<RadioPlayerState | null>(null);

// How many times a dropped stream is retried (with backoff) before giving
// up and surfacing as "stopped" — live streams occasionally hiccup (a brief
// server-side stall while switching tracks, a network blip), and neither
// the <audio> element nor a plain WebSocket retries those on its own, they
// just go silent. Self-healing here means a transient glitch doesn't force
// listeners to notice they've gone silent and manually re-press "Listen in".
const MAX_RECONNECT_ATTEMPTS = 6;
// Raw PCM sample rate the low-latency engine's AudioContext is created at —
// must match WS_AUDIO_SAMPLE_RATE in server/lib/workfmQueue.ts so no
// resampling is needed on either end.
const LOW_LATENCY_SAMPLE_RATE = 48000;


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

  // --- Low-latency engine state (WebSocket + raw PCM via an
  // AudioWorklet) — lives here, at the app root, rather than scoped to
  // /workfm's own page, for exactly the same reason the shared <audio>
  // element above does: so playback (and the ability to stop/mute it from
  // MiniPlayerBar) survives navigating to a completely different page. See
  // playLowLatency()/connectLowLatency()/stopLowLatency() below. ---
  const llWsRef = useRef<WebSocket | null>(null);
  const llCtxRef = useRef<AudioContext | null>(null);
  const llNodeRef = useRef<AudioWorkletNode | null>(null);
  const llGainRef = useRef<GainNode | null>(null);
  const llReconnectAttemptsRef = useRef(0);
  const llReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The room slug actually wanted right now, or null once stopped — reset
  // *before* any teardown side effects fire (mirrors nowPlayingRef's own
  // "set synchronously first" comment in stop() below), so a WS close
  // triggered by our own teardown is never mistaken for a drop worth
  // reconnecting.
  const llWantedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    nowPlayingRef.current = nowPlaying;
  }, [nowPlaying]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (llGainRef.current) llGainRef.current.gain.value = volume;
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
  // some callers autoplay on mount with no dedicated "Listen live" button to
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
      if (audio && nowPlayingRef.current && !nowPlayingRef.current.lowLatencySlug) {
        audio.play().catch(() => {});
      }
    };
    document.addEventListener("pointerdown", retry, { once: true });
    document.addEventListener("keydown", retry, { once: true });
  }

  function clearLowLatencyReconnect() {
    if (llReconnectTimerRef.current) {
      clearTimeout(llReconnectTimerRef.current);
      llReconnectTimerRef.current = null;
    }
    llReconnectAttemptsRef.current = 0;
  }

  /** Tears down the low-latency engine's WebSocket and audio graph —
   * always safe to call even if it was never started. */
  function stopLowLatency() {
    clearLowLatencyReconnect();
    llWantedSlugRef.current = null;
    const ws = llWsRef.current;
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: "listen", on: false }));
      } catch {
        // already closing/closed
      }
      try {
        ws.close();
      } catch {
        // already closed
      }
      llWsRef.current = null;
    }
    llNodeRef.current?.port.postMessage("reset");
    llNodeRef.current?.disconnect();
    llNodeRef.current = null;
    llGainRef.current?.disconnect();
    llGainRef.current = null;
    if (llCtxRef.current) {
      llCtxRef.current.close().catch(() => {});
      llCtxRef.current = null;
    }
  }

  /** Opens (or reopens, on reconnect) the low-latency WebSocket for
   * `slug`, building the AudioContext/AudioWorklet graph the first time —
   * called from a genuine click (WorkFm.tsx's "Listen in"/join handlers),
   * so the AudioContext starts in the "running" state per browser autoplay
   * policy rather than ever needing a muted-unmute trick. Ignores every
   * *text* frame this connection receives (state/chat/etc.) — it exists
   * purely to carry audio; the page itself keeps its own separate
   * connection for that (see useWorkFmLiveState). */
  async function connectLowLatency(slug: string) {
    llWantedSlugRef.current = slug;
    let ctx = llCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: LOW_LATENCY_SAMPLE_RATE });
      llCtxRef.current = ctx;
      try {
        await ctx.audioWorklet.addModule(new URL("./lib/pcmPlayerWorklet.js", import.meta.url));
      } catch (err) {
        console.error("[radio-player] failed to load low-latency audio worklet:", err);
        try {
          await ctx.close();
        } catch {
          // ignore
        }
        llCtxRef.current = null;
        return;
      }
      if (llWantedSlugRef.current !== slug) return; // stopped/superseded while awaiting
      const node = new AudioWorkletNode(ctx, "pcm-player", { outputChannelCount: [2] });
      const gain = ctx.createGain();
      gain.gain.value = volume;
      node.connect(gain);
      gain.connect(ctx.destination);
      llNodeRef.current = node;
      llGainRef.current = gain;
    }
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    if (llWantedSlugRef.current !== slug) return; // stopped/superseded while awaiting

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/workfm/rooms/${slug}/live`);
    ws.binaryType = "arraybuffer";
    llWsRef.current = ws;
    ws.onopen = () => {
      llReconnectAttemptsRef.current = 0;
      ws.send(JSON.stringify({ type: "listen", on: true }));
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) llNodeRef.current?.port.postMessage(event.data, [event.data]);
    };
    ws.onclose = () => {
      if (llWantedSlugRef.current !== slug) return; // stopped on purpose
      if (llReconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        stop();
        return;
      }
      llReconnectAttemptsRef.current += 1;
      const delay = Math.min(1000 * llReconnectAttemptsRef.current, 4000);
      llReconnectTimerRef.current = setTimeout(() => {
        if (llWantedSlugRef.current === slug) connectLowLatency(slug);
      }, delay);
    };
    ws.onerror = () => ws.close();
  }

  function play(url: string, label: string, opts?: PlayOpts) {
    clearReconnect();
    stopLowLatency();
    if (opts?.lowLatencySlug) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
      }
      setNowPlaying({ url, label, lowLatencySlug: opts.lowLatencySlug });
      connectLowLatency(opts.lowLatencySlug);
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;
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

  function toggle(url: string, label: string, opts?: PlayOpts) {
    if (nowPlayingRef.current?.url === url) {
      stop();
      return;
    }
    play(url, label, opts);
  }

  function stop() {
    clearReconnect();
    // Set synchronously (not just via the effect above, which only runs on
    // the next render) so the `pause` event this triggers is recognized as
    // intentional by handlePause below, instead of being auto-resumed.
    const wasLowLatency = !!nowPlayingRef.current?.lowLatencySlug;
    nowPlayingRef.current = null;
    if (wasLowLatency) {
      stopLowLatency();
    } else {
      const audio = audioRef.current;
      if (audio) audio.pause();
    }
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
    if (!current || current.lowLatencySlug || !audio) return; // stopped on purpose, or the low-latency engine's own WS handles its own reconnects — nothing to recover here
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
    if (audio && nowPlayingRef.current && !nowPlayingRef.current.lowLatencySlug) {
      audio.play().catch(() => armAutoplayRetry());
    }
  }

  function getAudioElement() {
    return audioRef.current;
  }

  return (
    <RadioPlayerContext.Provider value={{ nowPlaying, toggle, play, stop, volume, setVolume, getAudioElement }}>
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
