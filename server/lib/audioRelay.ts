// ---------------------------------------------------------------------------
// Smooths out the "hiccups" that live yt-dlp → ffmpeg relaying was prone to:
// previously ffmpeg was run with `-re` directly on the piped yt-dlp input,
// which paces its *output* to arrive in real time by pacing how fast it
// *reads* its input — meaning any brief slowdown in yt-dlp's network
// download (a slow chunk, a retry, a momentary stall) stalled ffmpeg's
// stdout in lockstep, which listeners heard as a stutter/gap in the audio.
//
// Instead, ffmpeg is now run *without* `-re`, so it transcodes as fast as
// the network delivers (bursty, but never stalled waiting on a clock), and
// relayPaced() below buffers that output and drips it out to listeners at
// the real playback bitrate itself. As long as there's a few seconds
// buffered ahead, a brief network stall just eats into that buffer instead
// of pausing the audible stream.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads `reader` (ffmpeg's stdout, running flat-out with no `-re`) into an
 * in-memory buffer and calls `onChunk` with pieces of it paced at
 * `bytesPerSec`, only starting once `prebufferBytes` have arrived (so a
 * track doesn't start already starved). Resolves once the source is
 * exhausted and fully drained, or as soon as `shouldStop()` says to bail
 * (e.g. the track was skipped).
 */
export async function relayPaced(
  // Narrowed to just the one method we use (rather than the full
  // ReadableStreamDefaultReader interface) so this works with both Bun's
  // and lib.dom's slightly different reader types without either one
  // complaining about the other's extra methods (e.g. Bun's `readMany`).
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  onChunk: (chunk: Uint8Array) => void,
  shouldStop: () => boolean,
  bytesPerSec: number,
  prebufferBytes: number
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let sourceDone = false;
  let readError: unknown = null;

  // Pumps ffmpeg's stdout into `chunks` as fast as it's willing to give it
  // to us — runs concurrently with the paced drain loop below.
  const pump = (async () => {
    try {
      while (!shouldStop()) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.length > 0) {
          chunks.push(value);
          bufferedBytes += value.length;
        }
      }
    } catch (err) {
      readError = err;
    } finally {
      sourceDone = true;
    }
  })();

  while (bufferedBytes < prebufferBytes && !sourceDone && !shouldStop()) {
    await sleep(50);
  }

  let sent = 0;
  const start = Date.now();
  while (!shouldStop()) {
    const targetBytes = Math.floor(((Date.now() - start) / 1000) * bytesPerSec);
    let toSend = targetBytes - sent;
    if (toSend <= 0) {
      if (sourceDone && bufferedBytes === 0) break; // fully drained + source finished
      await sleep(20);
      continue;
    }
    if (chunks.length === 0) {
      if (sourceDone) break; // nothing left to send, ever
      await sleep(20); // underrun — wait for the pump to catch up rather than busy-spin
      continue;
    }
    while (toSend > 0 && chunks.length > 0) {
      const head = chunks[0]!;
      if (head.length <= toSend) {
        onChunk(head);
        sent += head.length;
        toSend -= head.length;
        bufferedBytes -= head.length;
        chunks.shift();
      } else {
        onChunk(head.subarray(0, toSend));
        chunks[0] = head.subarray(toSend);
        sent += toSend;
        bufferedBytes -= toSend;
        toSend = 0;
      }
    }
  }

  await pump;
  if (readError) throw readError;
}
