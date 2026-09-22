import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// The server switches its "now playing" state (and the /queue poll result
// WorkFm.tsx reads) the instant a new track/announcement starts *encoding*,
// but the audio actually reaching a listener always lags behind that by a
// few seconds — server-side prebuffering plus, far more, the browser's own
// network/decode buffering before the shared <audio> element's `currentTime`
// starts advancing. Without correcting for that, the UI can label something
// "ANNOUNCEMENT" seconds before it's actually audible (or worse, while the
// tail of the previous track is still playing).
//
// The stream already carries in-band ICY metadata (see workfmQueue.ts's
// broadcast()/encodeIcyMeta()) at exact, known byte offsets. This hook opens
// a second, lightweight fetch of the same stream purely to walk that ICY
// framing and time each "StreamTitle" change against the stream's own
// encoded-audio clock (bytes-of-audio-so-far ÷ the fixed CBR bitrate) —
// nothing here is ever played, it's just used to measure timing. Comparing
// that same clock against the *playing* <audio> element's `currentTime`
// (which only advances once audio is actually decoded and rendered) tells
// us exactly when a given title becomes audible, regardless of however much
// buffering sits in between. Both connections open within milliseconds of
// each other against the same live broadcast, so their "content zero
// points" coincide closely enough for this to work without any wall-clock
// coordination.
// ---------------------------------------------------------------------------

// Matches AUDIO_BYTES_PER_SEC in server/lib/workfmQueue.ts (128kbps CBR ÷ 8).
const AUDIO_BYTES_PER_SEC = 16000;

export interface IcyTitleBoundary {
  /** The exact `StreamTitle` value from the ICY metadata block. */
  title: string;
  /** Seconds into the encoded audio stream (as measured from this fetch's
   * own start) at which this title takes effect. */
  atSec: number;
}

/**
 * Subscribes to `streamUrl`'s ICY metadata timeline and calls `onBoundary`
 * for each title change, in order, as soon as it's parsed (well ahead of
 * when it's actually audible — callers compare `atSec` against the actual
 * `<audio>` element's `currentTime` themselves, since only they know which
 * playback session's clock to measure against). No-ops if `streamUrl` is
 * null/undefined or the fetch fails (e.g. an older/incompatible browser) —
 * callers should fall back to updating their display immediately in that
 * case rather than getting stuck waiting forever.
 */
export function useIcyTitleTimeline(streamUrl: string | null | undefined, onBoundary: (boundary: IcyTitleBoundary) => void) {
  const onBoundaryRef = useRef(onBoundary);
  onBoundaryRef.current = onBoundary;

  useEffect(() => {
    if (!streamUrl) return;
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      let res: Response;
      try {
        res = await fetch(streamUrl, { headers: { "Icy-MetaData": "1" }, signal: controller.signal });
      } catch {
        return; // network error / aborted — caller's own fallback handles it
      }
      const metaint = Number(res.headers.get("icy-metaint") ?? "");
      const body = res.body;
      if (!body || !Number.isFinite(metaint) || metaint <= 0) return;

      const reader = body.getReader();
      let audioBytesSoFar = 0; // drives the atSec clock — excludes metadata bytes
      let bytesUntilMeta = metaint;
      // Carries a metadata block's bytes across separate `read()` chunks,
      // since chunk boundaries never line up with ICY framing boundaries.
      let pendingMetaBytesNeeded = 0;
      let metaBuf: Uint8Array[] = [];
      let lastTitle: string | null = null;

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          let offset = 0;
          while (offset < value.length) {
            if (pendingMetaBytesNeeded > 0) {
              const take = Math.min(pendingMetaBytesNeeded, value.length - offset);
              metaBuf.push(value.subarray(offset, offset + take));
              offset += take;
              pendingMetaBytesNeeded -= take;
              if (pendingMetaBytesNeeded === 0 && metaBuf.length > 0) {
                const text = metaBuf.map((b) => new TextDecoder().decode(b)).join("");
                metaBuf = [];
                const match = /StreamTitle='((?:[^']|\\')*)'/.exec(text);
                const title = match?.[1]?.replace(/\\'/g, "'") ?? "";
                if (title && title !== lastTitle) {
                  lastTitle = title;
                  onBoundaryRef.current({ title, atSec: audioBytesSoFar / AUDIO_BYTES_PER_SEC });
                }
              }
              continue;
            }
            if (bytesUntilMeta > 0) {
              const take = Math.min(bytesUntilMeta, value.length - offset);
              audioBytesSoFar += take;
              offset += take;
              bytesUntilMeta -= take;
              continue;
            }
            // At a metadata-length byte: length is in 16-byte units.
            const lengthByte = value[offset]!;
            offset += 1;
            const metaBytes = lengthByte * 16;
            bytesUntilMeta = metaint;
            if (metaBytes === 0) continue; // no metadata this cycle
            pendingMetaBytesNeeded = metaBytes;
          }
        }
      } catch {
        // stream ended/aborted — nothing more to time
      } finally {
        try {
          reader.cancel();
        } catch {
          // already closed
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [streamUrl]);
}
