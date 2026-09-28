import { useEffect, useRef } from "react";
import { api, type WorkFmQueueState } from "../api";

// How long a broken connection is allowed to keep retrying with backoff
// before giving up on WebSocket push entirely for this mount and just
// falling back to the old poll cadence — a bad proxy/corporate firewall
// blocking WebSocket upgrades entirely shouldn't leave the page frozen on
// stale data forever.
const MAX_RECONNECT_DELAY_MS = 8000;
const REST_FALLBACK_POLL_MS = 1500;

/**
 * Keeps `onState` fed with WorkFM's room state the instant anything changes
 * — chat, queue edits, votes, listeners, now playing — over one persistent
 * WebSocket per mount (see server/lib/workfmQueue.ts's attachWs()/
 * notifyState()), instead of the old fixed-interval poll. Falls back to
 * polling GET /queue at the old cadence if the socket can't connect at all
 * (blocked upgrade, proxy, etc.) so the page never goes fully stale.
 *
 * This connection is deliberately separate from — and, unlike it, does NOT
 * survive navigating away from — the low-latency *audio* WebSocket RadioPlayerContext
 * opens for "Listen in" (see its connectLowLatency()): state is only ever
 * meaningful while this exact page is mounted, whereas audio should keep
 * playing (and stay controllable from MiniPlayerBar) across the whole site.
 */
export function useWorkFmLiveState(slug: string, onState: (state: WorkFmQueueState) => void, onRoomMissing: () => void) {
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const onRoomMissingRef = useRef(onRoomMissing);
  onRoomMissingRef.current = onRoomMissing;

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let restPollTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let everConnected = false;

    async function restPollOnce() {
      try {
        const res = await api.workfmQueue(slug);
        if (!cancelled) onStateRef.current(res);
      } catch {
        if (!cancelled) onRoomMissingRef.current();
      }
    }

    function startRestFallback() {
      if (restPollTimer) return;
      restPollOnce();
      restPollTimer = setInterval(restPollOnce, REST_FALLBACK_POLL_MS);
    }

    function stopRestFallback() {
      if (restPollTimer) {
        clearInterval(restPollTimer);
        restPollTimer = null;
      }
    }

    function connect() {
      if (cancelled) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${location.host}/api/workfm/rooms/${slug}/live`);
      ws = socket;
      socket.onopen = () => {
        attempt = 0;
        everConnected = true;
        stopRestFallback();
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.type === "state") onStateRef.current(parsed.state as WorkFmQueueState);
        } catch {
          // ignore malformed message
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        attempt += 1;
        const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * 2 ** attempt);
        // A handful of failed attempts without ever having connected once
        // suggests WebSocket upgrades just don't reach the server at all
        // (corporate proxy, etc.) — poll in the meantime rather than
        // leaving the page frozen while reconnects keep quietly failing.
        if (!everConnected && attempt >= 3) startRestFallback();
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopRestFallback();
      ws?.close();
      ws = null;
    };
  }, [slug]);
}
