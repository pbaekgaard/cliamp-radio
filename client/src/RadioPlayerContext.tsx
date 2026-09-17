import { createContext, useContext, useRef, useState, type ReactNode } from "react";

interface NowPlaying {
  url: string;
  label: string;
}

interface RadioPlayerState {
  nowPlaying: NowPlaying | null;
  /** Toggles playback of `url` — pauses if it's already playing, otherwise switches to it. */
  toggle: (url: string, label: string) => void;
  stop: () => void;
}

const RadioPlayerContext = createContext<RadioPlayerState | null>(null);

// A single shared <audio> element for every "Tune in" button across the
// site, so clicking a different station/channel stops whatever was playing
// instead of stacking multiple streams on top of each other — like an
// actual radio's tuning dial.
export function RadioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);

  function toggle(url: string, label: string) {
    const audio = audioRef.current;
    if (!audio) return;
    if (nowPlaying?.url === url) {
      audio.pause();
      setNowPlaying(null);
      return;
    }
    audio.src = url;
    audio.play().catch(() => {});
    setNowPlaying({ url, label });
  }

  function stop() {
    const audio = audioRef.current;
    if (audio) audio.pause();
    setNowPlaying(null);
  }

  return (
    <RadioPlayerContext.Provider value={{ nowPlaying, toggle, stop }}>
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
