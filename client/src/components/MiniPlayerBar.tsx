import { useRadioPlayer } from "../RadioPlayerContext";

// A small persistent bar shown whenever a "Tune in" button is playing
// something, so listeners always have an obvious way to see what's
// streaming and stop it — regardless of which page they navigate to.
export default function MiniPlayerBar() {
  const { nowPlaying, stop } = useRadioPlayer();
  if (!nowPlaying) return null;

  return (
    <div className="mini-player-bar">
      <span className="mini-player-icon" aria-hidden="true">
        📻
      </span>
      <span className="mini-player-label">{nowPlaying.label}</span>
      <button className="btn-secondary" onClick={stop}>
        Stop
      </button>
    </div>
  );
}
