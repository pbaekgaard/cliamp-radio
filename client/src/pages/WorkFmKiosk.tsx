import { useEffect, useRef, useState } from "react";
import { api, type WorkFmChatMessage, type WorkFmQueueItem, type WorkFmQueueState } from "../api";
import { NowPlayingHero } from "../components/NowPlayingHero";
import { SpiseTidOverlay } from "../components/SpiseTidOverlay";
import { useChatEmotes } from "../lib/chatEmotes";
import { renderChatText } from "./WorkFm";

/** WorkFM's single persistent room slug — matches WORKFM_ROOM_SLUG in
 * WorkFm.tsx / server/lib/workfmRooms.ts. There's only ever this one room. */
const WORKFM_ROOM_SLUG = "workfm";

const EMPTY_STATE: WorkFmQueueState = {
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
};

/** Current wall-clock time, ticking every second — a kiosk sitting on a
 * shelf is as much a clock as a "what's playing" display. */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function UpNextRow({ item, position }: { item: WorkFmQueueItem; position: number }) {
  return (
    <li className="kiosk-queue-row">
      <span className="kiosk-queue-position">{position}</span>
      <div className="kiosk-queue-info">
        <span className="kiosk-queue-title">{item.title}</span>
        {!item.special && <span className="kiosk-queue-artist">{item.artist}</span>}
      </div>
      {!item.special && <span className="kiosk-queue-by muted">{item.addedBy}</span>}
    </li>
  );
}

/** Read-only, always-scrolled-to-bottom chat feed for the kiosk — the
 * kiosk has no keyboard/name, so this just follows along with whatever's
 * being said in the room, same rendering (emotes, links) as the real chat
 * panel on /workfm. */
function KioskChat({ messages }: { messages: WorkFmChatMessage[] }) {
  const emotes = useChatEmotes();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <aside className="kiosk-chat">
      <h2 className="kiosk-section-heading">Chat</h2>
      <ul className="kiosk-chat-list" ref={listRef}>
        {messages.map((m) =>
          m.system ? (
            <li key={m.id} className="kiosk-chat-row kiosk-chat-row-system">
              <span>{m.text}</span>
            </li>
          ) : (
            <li key={m.id} className="kiosk-chat-row">
              <span className="kiosk-chat-name" style={{ color: m.color }}>{m.name.toLowerCase()}</span>
              <span>{renderChatText(m.text, emotes)}</span>
            </li>
          )
        )}
        {messages.length === 0 && <li className="muted kiosk-chat-empty">No messages yet.</li>}
      </ul>
    </aside>
  );
}

export default function WorkFmKiosk() {
  const [state, setState] = useState<WorkFmQueueState>(EMPTY_STATE);
  const [roomMissing, setRoomMissing] = useState(false);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.workfmQueue(WORKFM_ROOM_SLUG);
        if (!cancelled) {
          setState(res);
          setRoomMissing(false);
        }
      } catch {
        if (!cancelled) setRoomMissing(true);
      }
    }
    poll();
    const id = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const listenerCount = state.members.length + state.anonymousListeners;
  const upNext = state.queue.slice(0, 5);
  const spiseTidActive = state.nowPlaying?.special === "spisetid";

  if (roomMissing) {
    return (
      <div className="kiosk-page">
        <p className="muted">Radio Bækgaard is temporarily unavailable — try refreshing in a moment.</p>
      </div>
    );
  }

  return (
    <div className={`kiosk-page${spiseTidActive ? " kiosk-page-spisetid" : ""}`}>
      <SpiseTidOverlay active={spiseTidActive} />
      <header className="kiosk-header">
        <div className="kiosk-brand">
          <span className="kiosk-live-dot" aria-hidden="true" />
          <span className="kiosk-brand-name">{state.roomName || "Radio Bækgaard"}</span>
        </div>
        <div className="kiosk-clock">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          <span className="kiosk-date muted">
            {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          </span>
        </div>
      </header>

      <main className="kiosk-body">
        <div className="kiosk-main-col">
          <NowPlayingHero item={state.nowPlaying} emptyHint="The queue is empty — add something from /workfm" />

          <section className="kiosk-upnext">
            <h2 className="kiosk-section-heading">Requests</h2>
            <ul className="kiosk-queue-list">
              {upNext.map((item, i) => (
                <UpNextRow key={item.id} item={item} position={i + 1} />
              ))}
              {upNext.length === 0 && <li className="muted kiosk-queue-empty">No requests</li>}
            </ul>
          </section>
        </div>

        <KioskChat messages={state.chat} />
      </main>

      <footer className="kiosk-footer">
        <div className="kiosk-listeners">
          <span className="kiosk-listeners-count">{listenerCount}</span>
          <span className="muted">{listenerCount === 1 ? "listener" : "listeners"} tuned in</span>
        </div>
        {state.members.length > 0 && (
          <div className="kiosk-members">
            {state.members.slice(0, 8).map((m) => (
              <span key={m.name} className={`kiosk-member-chip${m.listening ? " kiosk-member-listening" : ""}`}>
                {m.name}
              </span>
            ))}
            {state.members.length > 8 && <span className="muted">+{state.members.length - 8} more</span>}
          </div>
        )}
      </footer>
    </div>
  );
}
