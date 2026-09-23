import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type WorkFmChatMessage,
  type WorkFmMostPlayedEntry,
  type WorkFmLibraryTrack,
  type WorkFmLibraryView,
  type WorkFmMember,
  type WorkFmQueueItem,
  type WorkFmQueueState,
  type WorkFmSearchResult,
} from "../api";
import { readId3Tags, titleFromFilename } from "../id3";
import { useWorkFm } from "../WorkFmContext";
import { useRadioPlayer } from "../RadioPlayerContext";
import { useSyncedNowPlaying } from "../lib/useSyncedNowPlaying";
import { NowPlayingHero } from "../components/NowPlayingHero";

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** Distinguishes a pasted YouTube link — which can be added directly — from
 * anything else typed into the add-track box (a free-text search query, or
 * a Spotify link, both of which go through the search dropdown instead). */
function isYouTubeUrl(value: string): boolean {
  return /^https?:\/\/(www\.|music\.)?(youtube\.com|youtu\.be)\//i.test(
    value.trim(),
  );
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** Inline SVG icons for the vote buttons — plain emoji/glyphs render
 * inconsistently (or as blank boxes, for Nerd Font glyphs without that font
 * installed) across browsers/OSes, so these are drawn directly instead. */
function SkipIcon() {
  return (
    <svg
      className="workfm-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M6 5v14l10-7L6 5zm11 0v14h2V5h-2z" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg
      className="workfm-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"
      />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg
      className="workfm-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M12 21s-6.7-4.35-9.3-8.2C1 10.4 1.4 7.4 3.6 5.7c2-1.5 4.6-1.1 6.2.7l2.2 2.4 2.2-2.4c1.6-1.8 4.2-2.2 6.2-.7 2.2 1.7 2.6 4.7.9 7.1C18.7 16.65 12 21 12 21z"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      className="workfm-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg
      className="workfm-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M12 3l5 5h-3v6h-4V8H7l5-5zm-7 14h14v2H5v-2z"
      />
    </svg>
  );
}

/** Small centered dialog used for both joining a room and creating one.
 * Closes on Escape or a click on the backdrop. */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="workfm-modal-overlay" onClick={onClose}>
      <div
        className="workfm-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="workfm-modal-header">
          <h2>{title}</h2>
          <button
            className="workfm-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const PERSON_NAME_ADJECTIVES = [
  "Sneaky",
  "Grumpy",
  "Soggy",
  "Feral",
  "Spicy",
  "Zesty",
  "Wobbly",
  "Salty",
  "Nerdy",
  "Rowdy",
  "Cursed",
  "Extra",
  "Spooky",
  "Chaotic",
  "Gassy",
  "Sus",
];

const PERSON_NAME_NOUNS = [
  "Waffle",
  "Nacho",
  "Yeti",
  "Goblin",
  "Pickle",
  "Noodle",
  "Potato",
  "Raccoon",
  "Gremlin",
  "Biscuit",
  "Walrus",
  "Penguin",
  "Muffin",
  "Ferret",
  "Otter",
  "Weasel",
];

/** Rolls a short, silly handle (e.g. "Soggy Raccoon") for anyone who'd
 * rather not think of a name — well within the server's 24-char cap. */
function generateFunnyPersonName(): string {
  const adjective =
    PERSON_NAME_ADJECTIVES[
      Math.floor(Math.random() * PERSON_NAME_ADJECTIVES.length)
    ];
  const noun =
    PERSON_NAME_NOUNS[Math.floor(Math.random() * PERSON_NAME_NOUNS.length)];
  return `${adjective} ${noun}`;
}

/** Asks for the visitor's name to join a room already in progress — a
 * single-step modal, shown fresh every time (names aren't remembered
 * across rooms). Cancelling leaves them browsing anonymously. */
function JoinRoomModal({
  onClose,
  onJoin,
}: {
  onClose: () => void;
  onJoin: (name: string) => Promise<void>;
}) {
  const [yourName, setYourName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const finalName = yourName.trim() || generateFunnyPersonName();
    setYourName(finalName);
    setSubmitting(true);
    setError(null);
    try {
      await onJoin(finalName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Join this room" onClose={onClose}>
      <form className="workfm-modal-form" onSubmit={submit}>
        <label className="workfm-modal-label" htmlFor="workfm-join-name">
          What's your name?
        </label>
        <input
          id="workfm-join-name"
          autoFocus
          value={yourName}
          onChange={(e) => setYourName(e.target.value)}
          maxLength={24}
          placeholder="Pick a name…"
        />
        {error && <div className="error">{error}</div>}
        <div className="workfm-modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting
              ? "Joining…"
              : yourName.trim()
                ? "Join"
                : "Generate Random"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Lets the uploader pick an mp3, auto-fills title/artist from its ID3 tags
 * (falling back to a filename guess) but leaves both editable, and keeps
 * the "save for later" choice tucked away in here rather than on the main
 * room page. */
function UploadTrackModal({
  slug,
  onClose,
  onUploaded,
}: {
  slug: string;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [saveForLater, setSaveForLater] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    setError(null);
    const guess = titleFromFilename(picked.name);
    const tags = await readId3Tags(picked);
    setTitle(tags.title || guess.title);
    setArtist(tags.artist || guess.artist);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.workfmUploadToQueue(slug, file, saveForLater, {
        title,
        artist,
      });
      onUploaded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal title="Upload an MP3" onClose={onClose}>
      <form className="workfm-modal-form" onSubmit={submit}>
        <label className="workfm-modal-label" htmlFor="workfm-upload-file">
          Choose a file
        </label>
        <input
          id="workfm-upload-file"
          type="file"
          accept="audio/mpeg,.mp3"
          onChange={handleFileChange}
        />

        <label className="workfm-modal-label" htmlFor="workfm-upload-title">
          Title
        </label>
        <input
          id="workfm-upload-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="Track title"
        />

        <label className="workfm-modal-label" htmlFor="workfm-upload-artist">
          Artist
        </label>
        <input
          id="workfm-upload-artist"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          maxLength={200}
          placeholder="Artist"
        />

        <label className="muted workfm-save-checkbox">
          <input
            type="checkbox"
            checked={saveForLater}
            onChange={(e) => setSaveForLater(e.target.checked)}
          />
          Save for 2 months (so it can be requeued later)
        </label>

        {error && <div className="error">{error}</div>}

        <div className="workfm-modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            type="submit"
            disabled={uploading || !file}
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function QueueRow({
  item,
  isMine,
  isFirst,
  name,
  onRemove,
  onVoteNext,
}: {
  item: WorkFmQueueItem;
  isMine: boolean;
  isFirst: boolean;
  name: string | null;
  onRemove: (id: number) => void;
  onVoteNext: (id: number) => void;
}) {
  const nextVote = item.nextVote;
  return (
    <li className="workfm-queue-row">
      <div className="workfm-queue-row-info">
        <span className="workfm-queue-title">{item.title}</span>
        <span className="workfm-queue-artist">
          {item.artist}
          {item.source === "upload" && (
            <span className="workfm-upload-badge"> · uploaded</span>
          )}
        </span>
      </div>
      <div className="workfm-queue-row-meta">
        <span className="muted">
          added by <strong>{item.addedBy}</strong> · {timeAgo(item.addedAt)}
        </span>
        {!isFirst && nextVote && (
          <button
            className={`btn-secondary workfm-remove-btn${nextVote.hasVoted ? " workfm-vote-active" : ""}`}
            onClick={() => onVoteNext(item.id)}
            disabled={!name}
            title={
              nextVote.hasVoted
                ? "Remove your vote to bump this to the front"
                : "Vote to bump this to the front of the queue"
            }
          >
            ↑ Next {nextVote.votes}/{nextVote.total}
          </button>
        )}
        {isMine && (
          <button
            className="btn-secondary workfm-remove-btn"
            onClick={() => onRemove(item.id)}
          >
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function MembersPanel({
  members,
  anonymousListeners,
  name,
}: {
  members: WorkFmMember[];
  anonymousListeners: number;
  name: string | null;
}) {
  const total = members.length + anonymousListeners;
  return (
    <aside className="workfm-listeners-panel">
      <h2 className="workfm-listeners-heading">Who's here ({total})</h2>
      <ul className="workfm-listeners-list">
        {members.map((m) => (
          <li key={m.name} className="workfm-listener-row">
            <span>
              {m.name}
              {name && m.name.toLowerCase() === name.toLowerCase() && (
                <span className="workfm-you-tag">You</span>
              )}
            </span>
            <span className="workfm-listening-badge" title="Listening live">
              🎧 Listening
            </span>
          </li>
        ))}
        {anonymousListeners > 0 && (
          <li className="workfm-listener-row muted">
            <span>{anonymousListeners} via cliamp</span>
            <span className="workfm-listening-badge" title="Listening live">
              🎧 Listening
            </span>
          </li>
        )}
        {total === 0 && <li className="muted">Nobody's around right now.</li>}
      </ul>
    </aside>
  );
}

function ChatPanel({
  slug,
  messages,
  name,
  onSent,
}: {
  slug: string;
  messages: WorkFmChatMessage[];
  name: string | null;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.workfmPostChat(slug, text.trim());
      setText("");
      // Refresh right away instead of waiting on the next poll tick so the
      // sent message (and anything else that landed meanwhile) shows up
      // immediately rather than up to a few seconds later.
      onSent();
    } catch {
      // best-effort — the next poll will resync
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="workfm-chat-panel">
      <h2 className="workfm-listeners-heading">Chat</h2>
      <ul className="workfm-chat-list" ref={listRef}>
        {messages.map((m) => (
          <li key={m.id} className="workfm-chat-row">
            <strong>{m.name}</strong>: <span>{m.text}</span>
          </li>
        ))}
        {messages.length === 0 && <li className="muted">No messages yet.</li>}
      </ul>
      {name ? (
        <form className="workfm-chat-form" onSubmit={send}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            placeholder="Say something…"
            disabled={sending}
          />
          <button
            className="btn-secondary"
            type="submit"
            disabled={sending || !text.trim()}
          >
            Send
          </button>
        </form>
      ) : (
        <p className="muted">Join to chat.</p>
      )}
    </div>
  );
}

function MostPlayedPanel({
  mostPlayed,
  slug,
  name,
  onRequeued,
}: {
  mostPlayed: WorkFmMostPlayedEntry[];
  slug: string;
  name: string | null;
  onRequeued: () => void;
}) {
  async function requeue(id: string) {
    if (!name) return;
    try {
      await api.workfmRequeue(slug, id);
      onRequeued();
    } catch {
      // ignore — the requeue button already disables itself when unavailable
    }
  }

  return (
    <aside className="workfm-listeners-panel">
      <h2 className="workfm-listeners-heading">Most played songs</h2>
      <p className="muted workfm-leaderboard-hint">
        Top 5 most-played songs across every WorkFM room
      </p>
      <ul className="workfm-library-list">
        {mostPlayed.map((t, i) => (
          <li key={t.libraryId} className="workfm-library-row">
            <div className="workfm-queue-row-info">
              <span className="workfm-queue-title">
                {i + 1}. {t.title}
              </span>
              <span className="workfm-queue-artist">{t.artist}</span>
            </div>
            <div className="workfm-library-row-actions">
              <span className="muted">
                {t.playCount} {t.playCount === 1 ? "play" : "plays"}
              </span>
              {t.available && (
                <button
                  className="btn-secondary"
                  onClick={() => requeue(t.libraryId)}
                  disabled={!name}
                >
                  Requeue
                </button>
              )}
            </div>
          </li>
        ))}
        {mostPlayed.length === 0 && (
          <li className="muted">Nothing's played yet.</li>
        )}
      </ul>
    </aside>
  );
}

const LIBRARY_TABS: { view: WorkFmLibraryView; label: string }[] = [
  { view: "history", label: "History" },
  { view: "saved", label: "Saved uploads" },
];

function LibraryPanel({
  slug,
  name,
  onRequeued,
}: {
  slug: string;
  name: string | null;
  onRequeued: () => void;
}) {
  const [view, setView] = useState<WorkFmLibraryView>("history");
  const [tracks, setTracks] = useState<WorkFmLibraryTrack[]>([]);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setTracks(await api.workfmLibrary(view));
    } catch {
      // ignore transient errors
    }
  }, [view]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Reset any in-progress search when switching tabs, so a "saved uploads"
  // query doesn't silently keep filtering out history results (or vice versa).
  useEffect(() => {
    setQuery("");
  }, [view]);

  const q = query.trim().toLowerCase();
  const filteredTracks = q
    ? tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q),
      )
    : tracks;

  async function like(id: string) {
    if (!name) return;
    try {
      await api.workfmToggleLike(id);
      load();
    } catch {
      // ignore
    }
  }

  async function requeue(id: string) {
    if (!name) return;
    setError(null);
    try {
      await api.workfmRequeue(slug, id);
      onRequeued();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="workfm-library-panel">
      <button className="btn-secondary" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide library" : "Browse library"}
      </button>
      {open && (
        <div className="workfm-library-body">
          <div className="workfm-library-tabs">
            {LIBRARY_TABS.map((t) => (
              <button
                key={t.view}
                className={`btn-secondary${view === t.view ? " workfm-vote-active" : ""}`}
                onClick={() => setView(t.view)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {error && <div className="error">{error}</div>}
          <input
            className="workfm-library-search"
            type="search"
            placeholder={
              view === "history" ? "Search history…" : "Search saved uploads…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search library"
          />
          <ul className="workfm-library-list workfm-library-list-scroll">
            {filteredTracks.map((t) => (
              <li key={t.id} className="workfm-library-row">
                <div className="workfm-queue-row-info">
                  <span className="workfm-queue-title">{t.title}</span>
                  <span className="workfm-queue-artist">{t.artist}</span>
                </div>
                <div className="workfm-library-row-actions">
                  <button
                    className={`btn-secondary${t.likedByMe ? " workfm-vote-active" : ""}`}
                    onClick={() => like(t.id)}
                    disabled={!name}
                  >
                    ♥ {t.likes}
                  </button>
                  {t.available && (
                    <button
                      className="btn-secondary"
                      onClick={() => requeue(t.id)}
                      disabled={!name}
                    >
                      Requeue
                    </button>
                  )}
                </div>
              </li>
            ))}
            {filteredTracks.length === 0 && (
              <li className="muted">
                {tracks.length === 0 ? "Nothing here yet." : "No matches."}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function RoomPage({ slug }: { slug: string }) {
  const {
    name: identityName,
    roomSlug,
    identify,
    bindRoom,
    forget,
  } = useWorkFm();
  // A session restored on page load (see WorkFmProvider) doesn't know which
  // room it belongs to yet — bind it to this one now that we know it, so a
  // refresh doesn't look like "not joined" and force rejoining. Harmless to
  // rebind on every render where it's already a match; WorkFM only has this
  // one persistent room in practice.
  useEffect(() => {
    if (identityName && roomSlug !== slug) bindRoom(slug);
  }, [identityName, roomSlug, slug, bindRoom]);
  const name = roomSlug === slug ? identityName : null;
  const [state, setState] = useState<WorkFmQueueState>({
    roomName: "",
    nowPlaying: null,
    queue: [],
    listeners: [],
    anonymousListeners: 0,
    members: [],
    leaderboard: [],
    mostPlayed: [],
    skipVote: { votes: 0, total: 1, hasVoted: false },
    repeatVote: { armed: false, votes: 0, total: 1, hasVoted: false },
    chat: [],
  });
  const [roomMissing, setRoomMissing] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [searchResults, setSearchResults] = useState<WorkFmSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const { nowPlaying, toggle, play, stop } = useRadioPlayer();
  const streamUrl = `/cliamp-radio/live/workfm/${slug}.mp3`;
  const playing = nowPlaying?.url === streamUrl;
  // Lags behind state.nowPlaying until it's actually about to be audible —
  // see useSyncedNowPlaying's comment. Used for the "now playing" card
  // instead of state.nowPlaying directly.
  const displayedNowPlaying = useSyncedNowPlaying(
    state.nowPlaying,
    playing,
    streamUrl,
  );
  const navigate = useNavigate();
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await api.workfmQueue(slug);
      setState(res);
      setRoomMissing(false);
    } catch {
      setRoomMissing(true);
    }
  }, [slug]);

  useEffect(() => {
    poll();
    // Poll fairly often so chat and the queue feel close to real-time.
    const id = setInterval(poll, 1500);
    return () => clearInterval(id);
  }, [poll]);

  async function addToQueue(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!isYouTubeUrl(trimmed)) {
      // Enter pressed on a search query (rather than a pasted link) — add
      // the top result, same as clicking the first row in the dropdown.
      if (searchResults[0]) await addFromSearch(searchResults[0]);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.workfmAddToQueue(slug, trimmed);
      setUrl("");
      setSearchResults([]);
      setShowResults(false);
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Live-searches YouTube as the user types a non-URL query (debounced so we
  // don't spawn a yt-dlp process on every keystroke). Pasted links skip this
  // entirely and go straight through the existing add-by-URL path.
  useEffect(() => {
    const query = url.trim();
    if (!query || isYouTubeUrl(query)) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const { results } = await api.workfmSearch(slug, query);
        if (!cancelled) setSearchResults(results);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [url, slug]);

  async function addFromSearch(result: WorkFmSearchResult) {
    setSubmitting(true);
    setError(null);
    try {
      await api.workfmAddToQueue(
        slug,
        `https://www.youtube.com/watch?v=${result.videoId}`,
      );
      setUrl("");
      setSearchResults([]);
      setShowResults(false);
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.workfmRemoveFromQueue(slug, id);
      poll();
    } catch {
      // best-effort — the next poll will resync state if this failed silently
    }
  }

  async function voteNext(id: number) {
    try {
      await api.workfmVoteNext(slug, id);
      poll();
    } catch {
      // ignore — poll() will resync
    }
  }

  async function skip() {
    try {
      await api.workfmSkipCurrent(slug);
      poll();
    } catch {
      // ignore — poll() will resync
    }
  }

  async function repeat() {
    try {
      await api.workfmRepeatCurrent(slug);
      poll();
    } catch {
      // ignore — poll() will resync
    }
  }

  async function likeNowPlaying() {
    if (!displayedNowPlaying) return;
    try {
      await api.workfmToggleLike(displayedNowPlaying.libraryId);
      poll();
    } catch {
      // ignore — poll() will resync
    }
  }

  async function handleLeave() {
    // Leaving means tuning out entirely, not just forgetting the name.
    stop();
    await forget();
    navigate("/");
  }

  if (roomMissing) {
    return (
      <div className="workfm-page">
        <p className="muted">
          Radio Bækgaard is temporarily unavailable — try refreshing in a
          moment.
        </p>
      </div>
    );
  }

  return (
    <div className="workfm-page">
      <div className="workfm-header">
        <div>
          <h1>{state.roomName || "Radio Bækgaard"}</h1>
          {!name && (
            <p className="muted">
              Join to request tracks, upload MP3s, chat, like, or vote to skip.
            </p>
          )}
        </div>
        <div className="header-actions">
          {name ? (
            <>
              <button
                className="btn-secondary"
                onClick={() => toggle(streamUrl, "Radio Bækgaard")}
              >
                {playing ? "Pause stream" : "▶ Listen in"}
              </button>
              <button className="btn-danger" onClick={handleLeave}>
                Leave room
              </button>
            </>
          ) : (
            <button
              className="btn-primary"
              onClick={() => setShowJoinModal(true)}
            >
              Join
            </button>
          )}
        </div>
      </div>

      {showJoinModal && (
        <JoinRoomModal
          onClose={() => setShowJoinModal(false)}
          onJoin={async (yourName) => {
            // Clicking "Join"/"Generate Random" is a genuine user gesture,
            // so kick off playback right here (before the await) rather
            // than making the visitor separately press "Listen in"
            // afterwards — most people joining a room want to hear it.
            play(streamUrl, "Radio Bækgaard");
            await identify(yourName, slug);
          }}
        />
      )}
      {showUploadModal && (
        <UploadTrackModal
          slug={slug}
          onClose={() => setShowUploadModal(false)}
          onUploaded={poll}
        />
      )}

      <div className="workfm-now-playing">
        <NowPlayingHero
          item={displayedNowPlaying}
          emptyHint="Add a video below!"
          controls={
            name && displayedNowPlaying ? (
              <>
                {!displayedNowPlaying.special && (
                  <>
                    <button
                      className={`workfm-control-btn workfm-control-like${displayedNowPlaying.likedByMe ? " active" : ""}`}
                      onClick={likeNowPlaying}
                      title="Like this song"
                    >
                      <HeartIcon />
                      <span className="workfm-control-count">
                        {displayedNowPlaying.likes}
                      </span>
                    </button>
                    <button
                      className={`workfm-control-btn workfm-control-skip${state.skipVote.hasVoted ? " active" : ""}`}
                      onClick={skip}
                      style={
                        {
                          "--vote-pct": `${state.skipVote.total > 0 ? (state.skipVote.votes / state.skipVote.total) * 100 : 0}%`,
                        } as React.CSSProperties
                      }
                      title={
                        state.skipVote.hasVoted
                          ? `Voted to skip (${state.skipVote.votes}/${state.skipVote.total})`
                          : `Vote to skip (${state.skipVote.votes}/${state.skipVote.total})`
                      }
                    >
                      <SkipIcon />
                      <span>Skip</span>
                      <span className="workfm-control-count">
                        {state.skipVote.votes}/{state.skipVote.total}
                      </span>
                    </button>
                    <button
                      className={`workfm-control-btn workfm-control-repeat${state.repeatVote.armed || state.repeatVote.hasVoted ? " active" : ""}`}
                      onClick={repeat}
                      style={
                        {
                          "--vote-pct": `${state.repeatVote.total > 0 ? (state.repeatVote.votes / state.repeatVote.total) * 100 : 0}%`,
                        } as React.CSSProperties
                      }
                      title={
                        state.repeatVote.hasVoted
                          ? `Voted to repeat (${state.repeatVote.votes}/${state.repeatVote.total})`
                          : `Vote to repeat (${state.repeatVote.votes}/${state.repeatVote.total})`
                      }
                    >
                      <RepeatIcon />
                      <span>Repeat</span>
                      <span className="workfm-control-count">
                        {state.repeatVote.votes}/{state.repeatVote.total}
                      </span>
                    </button>
                  </>
                )}
                {displayedNowPlaying.special === "ad" && (
                  <button
                    className={`workfm-control-btn workfm-control-skip${state.skipVote.hasVoted ? " active" : ""}`}
                    onClick={skip}
                    style={
                      {
                        "--vote-pct": `${state.skipVote.total > 0 ? (state.skipVote.votes / state.skipVote.total) * 100 : 0}%`,
                      } as React.CSSProperties
                    }
                    title={
                      state.skipVote.hasVoted
                        ? `Voted to skip ad break (${state.skipVote.votes}/${state.skipVote.total})`
                        : `Vote to skip ad break (${state.skipVote.votes}/${state.skipVote.total})`
                    }
                  >
                    <SkipIcon />
                    <span>Skip ads</span>
                    <span className="workfm-control-count">
                      {state.skipVote.votes}/{state.skipVote.total}
                    </span>
                  </button>
                )}
              </>
            ) : null
          }
          hint={
            name &&
            displayedNowPlaying &&
            !displayedNowPlaying.special &&
            state.repeatVote.armed
              ? "This track will play again when it ends."
              : null
          }
        />
      </div>

      <div className="workfm-layout">
        <div className="workfm-main">
          {name && (
            <>
              <div className="workfm-request-panel">
                <p className="workfm-request-label">Request a track</p>
                <div className="workfm-add-wrap">
                  <form className="workfm-add-form" onSubmit={addToQueue}>
                    <input
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setShowResults(true);
                      }}
                      onFocus={() => setShowResults(true)}
                      onBlur={() =>
                        setTimeout(() => setShowResults(false), 150)
                      }
                      placeholder="Search YouTube, or paste a YouTube/Spotify link…"
                    />
                    <button
                      className="btn-primary"
                      type="submit"
                      disabled={
                        submitting ||
                        !url.trim() ||
                        (!isYouTubeUrl(url) && searchResults.length === 0)
                      }
                    >
                      <PlusIcon /> {submitting ? "Adding…" : "Add"}
                    </button>
                  </form>
                  {showResults && url.trim() && !isYouTubeUrl(url) && (
                    <div className="workfm-search-results">
                      {searching && (
                        <div className="workfm-search-status muted">
                          Searching…
                        </div>
                      )}
                      {!searching && searchResults.length === 0 && (
                        <div className="workfm-search-status muted">
                          No results
                        </div>
                      )}
                      {searchResults.map((r) => (
                        <button
                          key={r.videoId}
                          type="button"
                          className="workfm-search-result"
                          disabled={submitting}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => addFromSearch(r)}
                        >
                          {r.thumbnail && <img src={r.thumbnail} alt="" />}
                          <div className="workfm-search-result-meta">
                            <div className="workfm-search-result-title">
                              {r.title}
                            </div>
                            <div className="muted">
                              {r.uploader ?? "Unknown"}
                              {typeof r.durationSec === "number"
                                ? ` · ${formatClock(r.durationSec)}`
                                : ""}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {error && <div className="error">{error}</div>}
                <div className="workfm-upload-row">
                  <span className="muted">or</span>
                  <button
                    className="workfm-upload-btn"
                    onClick={() => setShowUploadModal(true)}
                  >
                    <UploadIcon /> Upload an MP3
                  </button>
                </div>
              </div>
            </>
          )}

          <h2 className="workfm-queue-heading">
            Up next ({state.queue.length})
          </h2>
          <ul className="workfm-queue-list">
            {state.queue.map((item, i) => (
              <QueueRow
                key={item.id}
                item={item}
                isMine={
                  !!name && item.addedBy.toLowerCase() === name.toLowerCase()
                }
                isFirst={i === 0}
                name={name}
                onRemove={remove}
                onVoteNext={voteNext}
              />
            ))}
            {state.queue.length === 0 && (
              <li className="muted">
                The queue is empty — be the first to add a track.
              </li>
            )}
          </ul>

          <LibraryPanel slug={slug} name={name} onRequeued={poll} />
        </div>

        <div className="workfm-sidebar">
          <MostPlayedPanel
            mostPlayed={state.mostPlayed}
            slug={slug}
            name={name}
            onRequeued={poll}
          />
          <MembersPanel
            members={state.members}
            anonymousListeners={state.anonymousListeners}
            name={name}
          />
          <ChatPanel
            slug={slug}
            messages={state.chat}
            name={name}
            onSent={poll}
          />
        </div>
      </div>
    </div>
  );
}

/** WorkFM's single persistent room slug — matches WORKFM_ROOM_SLUG on the
 * server (see server/lib/workfmRooms.ts). There's only ever this one room. */
const WORKFM_ROOM_SLUG = "workfm";

export default function WorkFm() {
  const { loading } = useWorkFm();
  if (loading) return null;
  return <RoomPage slug={WORKFM_ROOM_SLUG} />;
}
