// AudioWorkletProcessor for WorkFM's low-latency PCM audio path — see
// RadioPlayerContext.tsx's connectLowLatency(), which posts raw s16le PCM
// chunks straight off a WebSocket (exactly as produced by the server's
// repackager — see server/lib/workfmQueue.ts's ensureRepackager()) into
// this processor's port. Runs on the dedicated audio rendering thread,
// decoupled from the main thread's React render loop, so UI jank can never
// itself cause an audio glitch.
//
// Keeps a small FIFO queue of already-decoded stereo Float32 chunks ahead
// of however many samples are needed per 128-sample render quantum. An
// empty queue (network hasn't kept up) just renders silence for that
// quantum rather than glitching — the zero-initialized output arrays the
// Web Audio spec hands `process()` do this for free.
//
// Plain JavaScript (not TypeScript) deliberately: this file is loaded via
// `audioWorklet.addModule(new URL("./pcmPlayerWorklet.js", import.meta.url))`,
// which Vite resolves to a real, separately built script — but Vite's
// static-asset URL handling picks the served MIME type by file extension,
// and ".ts" collides with the real "video/mp2t" MPEG-transport-stream MIME
// type, which browsers correctly refuse to load as a JS module. Using
// ".js" avoids that collision; since this file only runs inside the
// isolated AudioWorkletGlobalScope (never imported by app code, and outside
// tsc's `src` type-checking of *.ts anyway), skipping TypeScript here costs
// nothing.

class PcmPlayerProcessor extends AudioWorkletProcessor {
  chunks = [];
  offset = 0; // samples of chunks[0] already consumed

  constructor() {
    super();
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === "reset") {
        this.chunks = [];
        this.offset = 0;
        return;
      }
      if (data instanceof ArrayBuffer) this.enqueue(data);
    };
  }

  /** Splits a raw s16le interleaved-stereo buffer into per-channel Float32
   * samples normalized to [-1, 1], matching AudioBuffer's expected range. */
  enqueue(buffer) {
    const bytesPerFrame = 4; // 2 channels * 2 bytes (s16le)
    const frameCount = Math.floor(buffer.byteLength / bytesPerFrame);
    if (frameCount <= 0) return;
    const view = new DataView(buffer);
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      left[i] = view.getInt16(i * bytesPerFrame, true) / 32768;
      right[i] = view.getInt16(i * bytesPerFrame + 2, true) / 32768;
    }
    this.chunks.push({ left, right });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];
    if (!outL) return true;
    const frames = outL.length;
    let written = 0;
    while (written < frames) {
      const chunk = this.chunks[0];
      if (!chunk) break; // underrun — remainder stays silent (zero-filled already)
      const available = chunk.left.length - this.offset;
      const take = Math.min(available, frames - written);
      outL.set(chunk.left.subarray(this.offset, this.offset + take), written);
      outR.set(chunk.right.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      if (this.offset >= chunk.left.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return true; // keep this processor alive indefinitely — the stream never "ends"
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
