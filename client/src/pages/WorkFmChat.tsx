import { useCallback, useEffect, useState } from "react";
import { api, type WorkFmChatMessage, type WorkFmMember } from "../api";
import { useWorkFm } from "../WorkFmContext";
import { ChatPanel, JoinRoomModal, WORKFM_ROOM_SLUG } from "./WorkFm";

/** Chat-only view of the WorkFM room: no player, no queue, no sidebar —
 * just the same live chat, fullscreen, for dropping into a second window
 * or tab while listening elsewhere. Joins independently of `/workfm` (same
 * shared identity/cookie), so visiting this directly still requires
 * picking a name the first time, but it's remembered afterwards exactly
 * like the main page. */
export default function WorkFmChat() {
  const { name, loading, identify } = useWorkFm();
  const [messages, setMessages] = useState<WorkFmChatMessage[]>([]);
  const [members, setMembers] = useState<WorkFmMember[]>([]);
  const [anonymousListeners, setAnonymousListeners] = useState(0);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [roomMissing, setRoomMissing] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await api.workfmQueue(WORKFM_ROOM_SLUG);
      setMessages(res.chat);
      setMembers(res.members);
      setAnonymousListeners(res.anonymousListeners);
      setRoomMissing(false);
    } catch {
      setRoomMissing(true);
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1500);
    return () => clearInterval(id);
  }, [poll]);

  if (loading) return null;

  if (roomMissing) {
    return (
      <div className="workfm-chat-fullscreen-page">
        <p className="muted">The room hasn't been created yet — visit /workfm first.</p>
      </div>
    );
  }

  return (
    <div className="workfm-chat-fullscreen-page">
      {!name && (
        <button
          className="btn-primary workfm-chat-fullscreen-join-btn"
          onClick={() => setShowJoinModal(true)}
        >
          Join to chat
        </button>
      )}
      <ChatPanel
        slug={WORKFM_ROOM_SLUG}
        messages={messages}
        name={name}
        onSent={poll}
        members={members}
        anonymousListeners={anonymousListeners}
        autoFocus
      />
      {showJoinModal && (
        <JoinRoomModal
          onClose={() => setShowJoinModal(false)}
          onJoin={async (yourName) => {
            await identify(yourName, WORKFM_ROOM_SLUG);
          }}
        />
      )}
    </div>
  );
}
