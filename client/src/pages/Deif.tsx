import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeifQueueItem, type DeifQueueState } from "../api";
import { useDeif } from "../DeifContext";

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function IdentifyForm() {
  const { identify } = useDeif();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await identify(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="center-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>DEIF FM</h1>
        <p className="muted">Pick a name so people can see who requested each track — no password needed.</p>
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            autoFocus
            placeholder="e.g. Peter"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn-primary" type="submit" disabled={submitting || !name.trim()}>
          {submitting ? "Joining…" : "Join the queue"}
        </button>
      </form>
    </div>
  );
}

function QueueRow({
  item,
  isMine,
  onRemove,
}: {
  item: DeifQueueItem;
  isMine: boolean;
  onRemove: (id: number) => void;
}) {
  return (
    <li className="deif-queue-row">
      <div className="deif-queue-row-info">
        <span className="deif-queue-title">{item.title}</span>
        <span className="deif-queue-artist">{item.artist}</span>
      </div>
      <div className="deif-queue-row-meta">
        <span className="muted">
          added by <strong>{item.addedBy}</strong> · {timeAgo(item.addedAt)}
        </span>
        {isMine && (
          <button className="btn-secondary deif-remove-btn" onClick={() => onRemove(item.id)}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function QueuePanel() {
  const { name, forget } = useDeif();
  const [state, setState] = useState<DeifQueueState>({ nowPlaying: null, queue: [] });
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await api.deifQueue();
      setState(res);
    } catch {
      // ignore transient network errors
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [poll]);

  async function addToQueue(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.deifAddToQueue(url.trim());
      setUrl("");
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.deifRemoveFromQueue(id);
      poll();
    } catch {
      // best-effort — the next poll will resync state if this failed silently
    }
  }

  async function skip() {
    try {
      await api.deifSkipCurrent();
      poll();
    } catch {
      // ignore — poll() will resync
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => {});
      setPlaying(true);
    }
  }

  const isMineNowPlaying = state.nowPlaying && name && state.nowPlaying.addedBy.toLowerCase() === name.toLowerCase();

  return (
    <div className="deif-page">
      <div className="deif-header">
        <div>
          <h1>DEIF FM</h1>
          <p className="muted">
            Signed in as <strong>{name}</strong>
          </p>
        </div>
        <div className="header-actions">
          <button className="btn-secondary" onClick={togglePlayback}>
            {playing ? "Pause stream" : "▶ Listen live"}
          </button>
          <button className="btn-secondary" onClick={forget}>
            Not you?
          </button>
        </div>
      </div>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} src="/cliamp-radio/live/deif-fm.mp3" preload="none" />

      <div className="deif-now-playing">
        <p className="deif-now-playing-label">Now playing</p>
        {state.nowPlaying ? (
          <div className="deif-now-playing-card">
            <div>
              <div className="deif-now-playing-title">{state.nowPlaying.title}</div>
              <div className="muted">{state.nowPlaying.artist}</div>
              <div className="muted">
                requested by <strong>{state.nowPlaying.addedBy}</strong>
              </div>
            </div>
            {isMineNowPlaying && (
              <button className="btn-secondary" onClick={skip}>
                Skip
              </button>
            )}
          </div>
        ) : (
          <div className="deif-now-playing-card muted">Nothing playing yet — add a video below!</div>
        )}
      </div>

      <form className="deif-add-form" onSubmit={addToQueue}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a YouTube video link…"
        />
        <button className="btn-primary" type="submit" disabled={submitting || !url.trim()}>
          {submitting ? "Adding…" : "Add to queue"}
        </button>
      </form>
      {error && <div className="error">{error}</div>}

      <h2 className="deif-queue-heading">Up next ({state.queue.length})</h2>
      <ul className="deif-queue-list">
        {state.queue.map((item) => (
          <QueueRow
            key={item.id}
            item={item}
            isMine={!!name && item.addedBy.toLowerCase() === name.toLowerCase()}
            onRemove={remove}
          />
        ))}
        {state.queue.length === 0 && <li className="muted">The queue is empty — be the first to add a track.</li>}
      </ul>
    </div>
  );
}

export default function Deif() {
  const { name, loading } = useDeif();
  if (loading) return null;
  return name ? <QueuePanel /> : <IdentifyForm />;
}
