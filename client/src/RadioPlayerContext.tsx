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
  stop: () => void;
  /** 0–1, local to this browser only — doesn't affect anyone else listening. */
  volume: number;
  setVolume: (volume: number) => void;
}

const RadioPlayerContext = createContext<RadioPlayerState | null>(null);

// A single shared <audio> element for every "Tune in" button across the
// site, so clicking a different station/channel stops whatever was playing
// instead of stacking multiple streams on top of each other — like an
// actual radio's tuning dial.
export function RadioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [volume, setVolumeState] = useState(loadStoredVolume);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  function toggle(url: string, label: string) {
    const audio = audioRef.current;
    if (!audio) return;
    if (nowPlaying?.url === url) {
      audio.pause();
      setNowPlaying(null);
      return;
    }
    audio.src = url;
    audio.volume = volume;
    audio.play().catch(() => {});
    setNowPlaying({ url, label });
  }

  function stop() {
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

  return (
    <RadioPlayerContext.Provider value={{ nowPlaying, toggle, stop, volume, setVolume }}>
      {children}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="none" onEnded={stop} onError={stop} />
    </RadioPlayerContext.Provider>
  );
}

export function useRadioPlayer() {
  const ctx = useContext(RadioPlayerContext);
  if (!ctx) throw new Error("useRadioPlayer must be used within RadioPlayerProvider");
  return ctx;
}
