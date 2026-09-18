import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type WorkFmChatMessage,
  type WorkFmLeaderboardEntry,
  type WorkFmLibraryTrack,
  type WorkFmLibraryView,
  type WorkFmMember,
  type WorkFmQueueItem,
  type WorkFmQueueState,
  type WorkFmRoomSummary,
} from "../api";
import { readId3Tags, titleFromFilename } from "../id3";
import { useAuth } from "../AuthContext";
import { useWorkFm } from "../WorkFmContext";
import { useRadioPlayer } from "../RadioPlayerContext";

function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** Small centered dialog used for both joining a room and creating one.
 * Closes on Escape or a click on the backdrop. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="workfm-modal-overlay" onClick={onClose}>
      <div className="workfm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="workfm-modal-header">
          <h2>{title}</h2>
          <button className="workfm-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Step-progress indicator ("1 ● — ○ 2" style) shown at the top of
 * multi-step modals, e.g. room creation. */
function ModalSteps({ step, total }: { step: number; total: number }) {
  return (
    <div className="workfm-modal-steps">
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <div key={n} className="workfm-modal-step-wrap">
          <span
            className={`workfm-modal-step${n === step ? " active" : ""}${n < step ? " done" : ""}`}
          >
            {n < step ? "✓" : n}
          </span>
          {n < total && <span className={`workfm-modal-step-line${n < step ? " done" : ""}`} />}
        </div>
      ))}
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
  const adjective = PERSON_NAME_ADJECTIVES[Math.floor(Math.random() * PERSON_NAME_ADJECTIVES.length)];
  const noun = PERSON_NAME_NOUNS[Math.floor(Math.random() * PERSON_NAME_NOUNS.length)];
  return `${adjective} ${noun}`;
}

/** Asks for the visitor's name to join a room already in progress — a
 * single-step modal, shown fresh every time (names aren't remembered
 * across rooms). Cancelling leaves them browsing anonymously. */
function JoinRoomModal({ onClose, onJoin }: { onClose: () => void; onJoin: (name: string) => Promise<void> }) {
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
            {submitting ? "Joining…" : yourName.trim() ? "Join" : "Generate Random"}
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
      await api.workfmUploadToQueue(slug, file, saveForLater, { title, artist });
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
        <input id="workfm-upload-file" type="file" accept="audio/mpeg,.mp3" onChange={handleFileChange} />

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
          <input type="checkbox" checked={saveForLater} onChange={(e) => setSaveForLater(e.target.checked)} />
          Save for 2 months (so it can be requeued later)
        </label>

        {error && <div className="error">{error}</div>}

        <div className="workfm-modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" type="submit" disabled={uploading || !file}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Two-step modal for spinning up a new room: room name, then the
 * creator's own name. Backing out of either step (closing the modal)
 * creates nothing. */
const ROOM_NAME_ADJECTIVES = [
  "Sweaty",
  "Feral",
  "Unhinged",
  "Rowdy",
  "Suspicious",
  "Caffeinated",
  "Illegal",
  "Radioactive",
  "Gassy",
  "Cursed",
  "Drunk",
  "Haunted",
  "Spicy",
  "Chaotic",
  "Overcooked",
  "Screaming",
  "Slippery",
  "Forbidden",
  "Wobbly",
  "Deranged",
];

const ROOM_NAME_NOUNS = [
  "Llama Karaoke",
  "Disco Inferno",
  "Goblin Rave",
  "Taco Emergency",
  "Printer Jam",
  "Raccoon Meeting",
  "Conference Call",
  "Group Chat",
  "Fax Machine",
  "Casserole Club",
  "Traffic Cone",
  "Pigeon Council",
  "Vending Machine",
  "Hot Tub Committee",
  "Karaoke Cult",
  "Spreadsheet Party",
  "Gremlin Lounge",
  "Toaster Bath",
  "Speed Dating",
  "Squirrel Riot",
];

/** Slaps together a silly adjective + noun (plus a two-digit number for
 * flavor) so "Generate Random" never needs a network round-trip. */
function generateFunnyRoomName(): string {
  const adjective = ROOM_NAME_ADJECTIVES[Math.floor(Math.random() * ROOM_NAME_ADJECTIVES.length)];
  const noun = ROOM_NAME_NOUNS[Math.floor(Math.random() * ROOM_NAME_NOUNS.length)];
  const number = Math.floor(Math.random() * 90) + 10;
  return `${adjective} ${noun} ${number}`;
}

function CreateRoomModal({ onClose }: { onClose: () => void }) {
  const { identify, bindRoom } = useWorkFm();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [roomName, setRoomName] = useState("");
  // Holds a generated name when "Generate Random" was used, kept out of the
  // visible input so it stays a surprise until after the room is created.
  const [randomRoomName, setRandomRoomName] = useState<string | null>(null);
  const [yourName, setYourName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function goToStep2(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = roomName.trim();
    if (!trimmed) {
      // Nothing typed yet: this submit came from the "Generate Random"
      // button — roll a silly name (kept hidden) and move straight on.
      setRandomRoomName(generateFunnyRoomName());
      setStep(2);
      return;
    }
    setRandomRoomName(null);
    setStep(2);
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    const finalYourName = yourName.trim() || generateFunnyPersonName();
    setYourName(finalYourName);
    setSubmitting(true);
    setError(null);
    try {
      await identify(finalYourName, "");
      const room = await api.workfmCreateRoom(randomRoomName ?? roomName.trim());
      bindRoom(room.slug);
      onClose();
      navigate(`/workfm/${room.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create a room" onClose={onClose}>
      <ModalSteps step={step} total={2} />
      {step === 1 ? (
        <form className="workfm-modal-form" onSubmit={goToStep2}>
          <label className="workfm-modal-label" htmlFor="workfm-new-room-name">
            What's the room name?
          </label>
          <input
            id="workfm-new-room-name"
            autoFocus
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            maxLength={40}
            placeholder="e.g. Friday jams"
          />
          <div className="workfm-modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" type="submit">
              {roomName.trim() ? "Next" : "Generate Random"}
            </button>
          </div>
        </form>
      ) : (
        <form className="workfm-modal-form" onSubmit={finish}>
          <label className="workfm-modal-label" htmlFor="workfm-creator-name">
            What's your name?
          </label>
          <input
            id="workfm-creator-name"
            autoFocus
            value={yourName}
            onChange={(e) => setYourName(e.target.value)}
            maxLength={24}
            placeholder="Pick a name…"
          />
          {error && <div className="error">{error}</div>}
          <div className="workfm-modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn-primary" type="submit" disabled={submitting}>
              {submitting ? "Creating…" : yourName.trim() ? "Create room" : "Generate Random"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function QueueRow({
  item,
  isMine,
  onRemove,
}: {
  item: WorkFmQueueItem;
  isMine: boolean;
  onRemove: (id: number) => void;
}) {
  return (
    <li className="workfm-queue-row">
      <div className="workfm-queue-row-info">
        <span className="workfm-queue-title">{item.title}</span>
        <span className="workfm-queue-artist">
          {item.artist}
          {item.source === "upload" && <span className="workfm-upload-badge"> · uploaded</span>}
        </span>
      </div>
      <div className="workfm-queue-row-meta">
        <span className="muted">
          added by <strong>{item.addedBy}</strong> · {timeAgo(item.addedAt)}
        </span>
        {isMine && (
          <button className="btn-secondary workfm-remove-btn" onClick={() => onRemove(item.id)}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function MembersPanel({ members, anonymousListeners }: { members: WorkFmMember[]; anonymousListeners: number }) {
  const total = members.length + anonymousListeners;
  return (
    <aside className="workfm-listeners-panel">
      <h2 className="workfm-listeners-heading">Who's here ({total})</h2>
      <ul className="workfm-listeners-list">
        {members.map((m) => (
          <li key={m.name} className="workfm-listener-row">
            <span>{m.name}</span>
            {m.listening && (
              <span className="workfm-listening-badge" title="Listening live">
                🎧 Listening
              </span>
            )}
          </li>
        ))}
        {anonymousListeners > 0 && (
          <li className="workfm-listener-row muted">
            <span>{anonymousListeners} via cliamp / unnamed</span>
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
          <button className="btn-secondary" type="submit" disabled={sending || !text.trim()}>
            Send
          </button>
        </form>
      ) : (
        <p className="muted">Join to chat.</p>
      )}
    </div>
  );
}

function SongLeaderboardPanel({
  leaderboard,
  slug,
  name,
  onRequeued,
}: {
  leaderboard: WorkFmLeaderboardEntry[];
  slug: string;
  name: string | null;
  onRequeued: () => void;
}) {
  async function like(id: string) {
    if (!name) return;
    try {
      await api.workfmToggleLike(id);
      onRequeued();
    } catch {
      // ignore — the next poll resyncs
    }
  }

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
      <h2 className="workfm-listeners-heading">🏆 Song leaderboard</h2>
      <ul className="workfm-library-list">
        {leaderboard.map((t, i) => (
          <li key={t.libraryId} className="workfm-library-row">
            <div className="workfm-queue-row-info">
              <span className="workfm-queue-title">
                {i + 1}. {t.title}
              </span>
              <span className="workfm-queue-artist">{t.artist}</span>
            </div>
            <div className="workfm-library-row-actions">
              <button
                className={`btn-secondary${t.likedByMe ? " workfm-vote-active" : ""}`}
                onClick={() => like(t.libraryId)}
                disabled={!name}
              >
                ♥ {t.likes}
              </button>
              {t.available && (
                <button className="btn-secondary" onClick={() => requeue(t.libraryId)} disabled={!name}>
                  Requeue
                </button>
              )}
            </div>
          </li>
        ))}
        {leaderboard.length === 0 && <li className="muted">No liked songs in this room yet.</li>}
      </ul>
    </aside>
  );
}

/** Global (cross-room) "Most liked" list — shown on the all-rooms overview
 * page, unlike SongLeaderboardPanel above which is scoped to one room. */
function MostLikedPanel() {
  const [tracks, setTracks] = useState<WorkFmLibraryTrack[]>([]);

  const load = useCallback(async () => {
    try {
      setTracks(await api.workfmLibrary("most-liked"));
    } catch {
      // ignore transient errors — next poll will retry
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const top = tracks.slice(0, 5);

  return (
    <aside className="workfm-listeners-panel workfm-most-liked-panel">
      <h2 className="workfm-listeners-heading">Most liked</h2>
      <ul className="workfm-library-list">
        {top.map((t, i) => (
          <li key={t.id} className="workfm-library-row">
            <div className="workfm-queue-row-info">
              <span className="workfm-queue-title">
                {i + 1}. {t.title}
              </span>
              <span className="workfm-queue-artist">{t.artist}</span>
            </div>
            <div className="workfm-library-row-actions">
              <span className="muted">♥ {t.likes}</span>
            </div>
          </li>
        ))}
        {top.length === 0 && <li className="muted">No liked songs yet — be the first!</li>}
      </ul>
    </aside>
  );
}

const LIBRARY_TABS: { view: WorkFmLibraryView; label: string }[] = [
  { view: "history", label: "History" },
  { view: "saved", label: "Saved uploads" },
];

function LibraryPanel({ slug, name, onRequeued }: { slug: string; name: string | null; onRequeued: () => void }) {
  const [view, setView] = useState<WorkFmLibraryView>("history");
  const [tracks, setTracks] = useState<WorkFmLibraryTrack[]>([]);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          <ul className="workfm-library-list">
            {tracks.map((t) => (
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
                    <button className="btn-secondary" onClick={() => requeue(t.id)} disabled={!name}>
                      Requeue
                    </button>
                  )}
                </div>
              </li>
            ))}
            {tracks.length === 0 && <li className="muted">Nothing here yet.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function RoomPage({ slug }: { slug: string }) {
  const { name: identityName, roomSlug, identify, forget } = useWorkFm();
  // WorkFM never carries a name across rooms — if the current identity was
  // picked for a different room (or none at all), treat this room as
  // "not joined" until the visitor picks a name via JoinRoomModal.
  const name = roomSlug === slug ? identityName : null;
  const navigate = useNavigate();
  const [state, setState] = useState<WorkFmQueueState>({
    roomName: "",
    nowPlaying: null,
    queue: [],
    listeners: [],
    anonymousListeners: 0,
    members: [],
    leaderboard: [],
    skipVote: { votes: 0, total: 1, hasVoted: false },
    repeatVote: { armed: false, votes: 0, total: 1, hasVoted: false },
    chat: [],
  });
  const [roomMissing, setRoomMissing] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { nowPlaying, toggle, stop } = useRadioPlayer();
  const streamUrl = `/cliamp-radio/live/workfm/${slug}.mp3`;
  const playing = nowPlaying?.url === streamUrl;
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
    setSubmitting(true);
    setError(null);
    try {
      await api.workfmAddToQueue(slug, url.trim());
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
      await api.workfmRemoveFromQueue(slug, id);
      poll();
    } catch {
      // best-effort — the next poll will resync state if this failed silently
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
    if (!state.nowPlaying) return;
    try {
      await api.workfmToggleLike(state.nowPlaying.libraryId);
      poll();
    } catch {
      // ignore — poll() will resync
    }
  }

  async function handleLeave() {
    // Leaving means tuning out entirely, not just forgetting the name.
    stop();
    await forget();
  }

  if (roomMissing) {
    return (
      <div className="workfm-page">
        <p className="muted">This room doesn't exist (maybe it was removed).</p>
        <button className="btn-secondary" onClick={() => navigate("/workfm")}>
          Back to rooms
        </button>
      </div>
    );
  }

  const majorityNeeded = Math.ceil(state.skipVote.total / 2);

  return (
    <div className="workfm-page">
      <div className="workfm-header">
        <div>
          <Link to="/workfm" className="muted workfm-back-link">
            ← All rooms
          </Link>
          <h1>{state.roomName || "WorkFM"}</h1>
          {name ? (
            <p className="muted">
              Signed in as <strong>{name}</strong>
            </p>
          ) : (
            <p className="muted">Join to request tracks, upload MP3s, chat, like, or vote to skip.</p>
          )}
        </div>
        <div className="header-actions">
          {name ? (
            <>
              <button className="btn-secondary" onClick={() => toggle(streamUrl, "WorkFM")}>
                {playing ? "Pause stream" : "▶ Listen live"}
              </button>
              <button className="btn-danger" onClick={handleLeave}>
                Leave room
              </button>
            </>
          ) : (
            <button className="btn-primary" onClick={() => setShowJoinModal(true)}>
              Join
            </button>
          )}
        </div>
      </div>

      {showJoinModal && (
        <JoinRoomModal
          onClose={() => setShowJoinModal(false)}
          onJoin={(yourName) => identify(yourName, slug)}
        />
      )}
      {showUploadModal && (
        <UploadTrackModal slug={slug} onClose={() => setShowUploadModal(false)} onUploaded={poll} />
      )}

      <div className="workfm-layout">
        <div className="workfm-main">
          <div className="workfm-now-playing">
            <p className="workfm-now-playing-label">Now playing</p>
            {state.nowPlaying ? (
              <div className="workfm-now-playing-card">
                <div>
                  <div className="workfm-now-playing-title">{state.nowPlaying.title}</div>
                  <div className="muted">{state.nowPlaying.artist}</div>
                  <div className="muted">
                    requested by <strong>{state.nowPlaying.addedBy}</strong>
                  </div>
                </div>
                {name && (
                  <div className="workfm-now-playing-actions">
                    <button
                      className={`btn-secondary${state.nowPlaying.likedByMe ? " workfm-vote-active" : ""}`}
                      onClick={likeNowPlaying}
                      title="Like this song"
                    >
                      ♥ {state.nowPlaying.likes}
                    </button>
                    <button
                      className={`btn-secondary${state.skipVote.hasVoted ? " workfm-vote-active" : ""}`}
                      onClick={skip}
                    >
                      {state.skipVote.hasVoted
                        ? `Voted to skip (${state.skipVote.votes}/${state.skipVote.total})`
                        : `Vote to skip (${state.skipVote.votes}/${state.skipVote.total})`}
                    </button>
                    <button
                      className={`btn-secondary${state.repeatVote.armed || state.repeatVote.hasVoted ? " workfm-vote-active" : ""}`}
                      onClick={repeat}
                    >
                      {state.repeatVote.hasVoted
                        ? `Voted to repeat (${state.repeatVote.votes}/${state.repeatVote.total})`
                        : `Vote to repeat (${state.repeatVote.votes}/${state.repeatVote.total})`}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="workfm-now-playing-card muted">Nothing playing yet — add a video below!</div>
            )}
            {name && state.nowPlaying && (
              <p className="muted workfm-vote-hint">
                Needs {majorityNeeded} of {state.skipVote.total} listening now to skip (a 50/50 split skips too).
              </p>
            )}
            {name && state.nowPlaying && state.repeatVote.armed && (
              <p className="muted workfm-vote-hint">This track will play again when it ends.</p>
            )}
          </div>

          {name && (
            <>
              <form className="workfm-add-form" onSubmit={addToQueue}>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube video link…" />
                <button className="btn-primary" type="submit" disabled={submitting || !url.trim()}>
                  {submitting ? "Adding…" : "Add to queue"}
                </button>
              </form>
              {error && <div className="error">{error}</div>}

              <div className="workfm-upload-row">
                <button className="btn-secondary" onClick={() => setShowUploadModal(true)}>
                  Upload an MP3
                </button>
              </div>
            </>
          )}

          <h2 className="workfm-queue-heading">Up next ({state.queue.length})</h2>
          <ul className="workfm-queue-list">
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

          <LibraryPanel slug={slug} name={name} onRequeued={poll} />
        </div>

        <div className="workfm-sidebar">
          <SongLeaderboardPanel
            leaderboard={state.leaderboard}
            slug={slug}
            name={name}
            onRequeued={poll}
          />
          <MembersPanel members={state.members} anonymousListeners={state.anonymousListeners} />
          <ChatPanel slug={slug} messages={state.chat} name={name} onSent={poll} />
        </div>
      </div>
    </div>
  );
}

function RoomsList() {
  const { username: adminUsername } = useAuth();
  const [rooms, setRooms] = useState<WorkFmRoomSummary[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const poll = useCallback(async () => {
    try {
      setRooms(await api.workfmListRooms());
    } catch {
      // ignore transient errors
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [poll]);

  async function deleteRoom(slug: string, name: string) {
    if (!confirm(`Delete room "${name}"? This can't be undone.`)) return;
    try {
      await api.workfmDeleteRoom(slug);
      poll();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="workfm-page">
      <div className="workfm-header">
        <div>
          <h1>WorkFM</h1>
          <p className="muted">Pick a room to join, or start a new one.</p>
        </div>
        <div className="header-actions">
          <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
            Create room
          </button>
        </div>
      </div>

      <div className="workfm-layout">
        <div className="workfm-main">
          <ul className="workfm-rooms-list">
            {rooms.map((room) => (
              <li key={room.slug} className="workfm-room-row">
                <Link to={`/workfm/${room.slug}`} className="workfm-room-link">
                  <div className="workfm-queue-row-info">
                    <span className="workfm-queue-title">{room.name}</span>
                    <span className="workfm-queue-artist">
                      {room.nowPlaying ? `${room.nowPlaying.title} — ${room.nowPlaying.artist}` : "Nothing playing"}
                    </span>
                  </div>
                  <div className="muted">
                    {room.members} in the room · {room.queueLength} queued
                  </div>
                </Link>
                {adminUsername && (
                  <button className="btn-secondary workfm-remove-btn" onClick={() => deleteRoom(room.slug, room.name)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
            {rooms.length === 0 && <li className="muted">No rooms open yet — create the first one!</li>}
          </ul>
        </div>

        <div className="workfm-sidebar">
          <MostLikedPanel />
        </div>
      </div>

      {showCreateModal && <CreateRoomModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}

export default function WorkFm() {
  const { loading } = useWorkFm();
  const { slug } = useParams<{ slug: string }>();
  if (loading) return null;
  return slug ? <RoomPage slug={slug} /> : <RoomsList />;
}
