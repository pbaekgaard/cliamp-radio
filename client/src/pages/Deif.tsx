import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeifQueueItem, type DeifQueueState } from "../api";
import { useDeif } from "../DeifContext";
import { useRadioPlayer } from "../RadioPlayerContext";

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// Lets an anonymous viewer pick a name to become a participant. Shown inline
// in the header (not a full-page gate) — anyone can browse the page
// (now playing, queue, listeners) without joining; joining is only needed to
// add tracks, upload, remove your own entries, or vote to skip.
function JoinForm() {
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
    <form className="deif-join-form" onSubmit={handleSubmit}>
      <div className="deif-join-form-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={24}
          placeholder="Pick a name…"
          aria-label="Your name"
        />
        <button className="btn-primary" type="submit" disabled={submitting || !name.trim()}>
          {submitting ? "Joining…" : "Join"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
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
        <span className="deif-queue-artist">
          {item.artist}
          {item.source === "upload" && <span className="deif-upload-badge"> · uploaded</span>}
        </span>
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

function ListenersPanel({ listeners }: { listeners: string[] }) {
  return (
    <aside className="deif-listeners-panel">
      <h2 className="deif-listeners-heading">Listeners ({listeners.length})</h2>
      <ul className="deif-listeners-list">
        {listeners.map((n) => (
          <li key={n} className="deif-listener-row">
            <span className="live-dot" />
            {n}
          </li>
        ))}
        {listeners.length === 0 && <li className="muted">Nobody else is on this page right now.</li>}
      </ul>
    </aside>
  );
}

function QueuePanel() {
  const { name, forget } = useDeif();
  const [state, setState] = useState<DeifQueueState>({
    nowPlaying: null,
    queue: [],
    listeners: [],
    skipVote: { votes: 0, total: 1, hasVoted: false },
  });
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { nowPlaying, toggle } = useRadioPlayer();
  const playing = nowPlaying?.url === "/cliamp-radio/live/deif-fm.mp3";

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

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      await api.deifUploadToQueue(file);
      poll();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  const isMineNowPlaying = state.nowPlaying && name && state.nowPlaying.addedBy.toLowerCase() === name.toLowerCase();
  const majorityNeeded = Math.ceil(state.skipVote.total / 2);

  return (
    <div className="deif-page">
      <div className="deif-header">
        <div>
          <h1>DEIF FM</h1>
          {name ? (
            <p className="muted">
              Signed in as <strong>{name}</strong>
            </p>
          ) : (
            <p className="muted">Join to request tracks, upload MP3s, or vote to skip.</p>
          )}
        </div>
        <div className="header-actions">
          <button className="btn-secondary" onClick={() => toggle("/cliamp-radio/live/deif-fm.mp3", "DEIF FM")}>
            {playing ? "Pause stream" : "▶ Listen live"}
          </button>
          {name ? (
            <button className="btn-secondary" onClick={forget}>
              Leave queue
            </button>
          ) : (
            <JoinForm />
          )}
        </div>
      </div>

      <div className="deif-layout">
        <div className="deif-main">
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
                {name && (
                  <button
                    className={`btn-secondary${state.skipVote.hasVoted ? " deif-vote-active" : ""}`}
                    onClick={skip}
                  >
                    {isMineNowPlaying
                      ? "Skip"
                      : state.skipVote.hasVoted
                        ? `Voted to skip (${state.skipVote.votes}/${state.skipVote.total})`
                        : `Vote to skip (${state.skipVote.votes}/${state.skipVote.total})`}
                  </button>
                )}
              </div>
            ) : (
              <div className="deif-now-playing-card muted">Nothing playing yet — add a video below!</div>
            )}
            {name && state.nowPlaying && !isMineNowPlaying && (
              <p className="muted deif-vote-hint">
                Needs {majorityNeeded} of {state.skipVote.total} listening now to skip (a 50/50 split skips too).
              </p>
            )}
          </div>

          {name && (
            <>
              <form className="deif-add-form" onSubmit={addToQueue}>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube video link…" />
                <button className="btn-primary" type="submit" disabled={submitting || !url.trim()}>
                  {submitting ? "Adding…" : "Add to queue"}
                </button>
              </form>
              {error && <div className="error">{error}</div>}

              <div className="deif-upload-row">
                <label className="btn-secondary deif-upload-label">
                  {uploading ? "Uploading…" : "Upload an MP3"}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="audio/mpeg,.mp3"
                    onChange={handleFileChange}
                    disabled={uploading}
                    hidden
                  />
                </label>
                <span className="muted">One file at a time — it's deleted once it's done playing.</span>
              </div>
              {uploadError && <div className="error">{uploadError}</div>}
            </>
          )}

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

        <ListenersPanel listeners={state.listeners} />
      </div>
    </div>
  );
}

export default function Deif() {
  const { loading } = useDeif();
  if (loading) return null;
  return <QueuePanel />;
}
