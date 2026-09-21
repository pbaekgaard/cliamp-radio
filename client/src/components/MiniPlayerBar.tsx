import { useRadioPlayer } from "../RadioPlayerContext";

// A small persistent bar shown whenever a "Tune in" button is playing
// something, so listeners always have an obvious way to see what's
// streaming and stop it — regardless of which page they navigate to.
//
// WorkFM's stream is deliberately excluded: being on the room page *is*
// listening (no separate tune-in/pause step — see WorkFm.tsx), so a global
// "Stop" button for it here would contradict that and would also be
// pointless, since navigating away from the room already stops it.
export default function MiniPlayerBar() {
  const { nowPlaying, stop, volume, setVolume } = useRadioPlayer();
  if (!nowPlaying || nowPlaying.url.startsWith("/cliamp-radio/live/workfm/")) return null;

  return (
    <div className="mini-player-bar">
      <span className="mini-player-icon" aria-hidden="true">
        📻
      </span>
      <span className="mini-player-label">{nowPlaying.label}</span>
      <span className="mini-player-volume">
        <span aria-hidden="true">{volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}</span>
        <input
          type="range"
          className="mini-player-volume-slider"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          aria-label="Volume (only affects your playback)"
          title="Volume (only affects your playback)"
        />
      </span>
      <button className="btn-secondary" onClick={stop}>
        Stop
      </button>
    </div>
  );
}
