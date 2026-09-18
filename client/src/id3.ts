// Minimal ID3v2 (2.2/2.3/2.4) reader — just enough to pull the title/artist
// text frames out of an mp3's header so the upload modal can pre-fill them.
// Deliberately doesn't pull in a whole tagging library for two text fields;
// falls back to filename-derived guesses (mirroring the server's
// titleFromFilename) when there's no usable tag, and always lets the
// uploader edit whatever comes back.

function decodeFrameText(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const encodingByte = bytes[0];
  const body = bytes.subarray(1);
  let text: string;
  try {
    if (encodingByte === 1 || encodingByte === 2) {
      // UTF-16 (with or without BOM) — encodingByte 1 has a leading BOM.
      const hasBom = encodingByte === 1 && body.length >= 2;
      const littleEndian = hasBom ? body[0] === 0xff && body[1] === 0xfe : false;
      const start = hasBom ? 2 : 0;
      const codeUnits: number[] = [];
      for (let i = start; i + 1 < body.length; i += 2) {
        codeUnits.push(littleEndian ? body[i]! | (body[i + 1]! << 8) : (body[i]! << 8) | body[i + 1]!);
      }
      text = String.fromCharCode(...codeUnits);
    } else if (encodingByte === 3) {
      text = new TextDecoder("utf-8").decode(body);
    } else {
      text = new TextDecoder("iso-8859-1").decode(body);
    }
  } catch {
    text = "";
  }
  // Trim trailing null terminators/padding.
  return text.replace(/\u0000+$/, "").trim();
}

function synchsafeToInt(bytes: Uint8Array): number {
  return ((bytes[0]! & 0x7f) << 21) | ((bytes[1]! & 0x7f) << 14) | ((bytes[2]! & 0x7f) << 7) | (bytes[3]! & 0x7f);
}

/** Reads the mp3's ID3v2 header (if present) and returns whatever title/artist
 * text frames it finds. Never throws — returns {} on anything unexpected. */
export async function readId3Tags(file: File): Promise<{ title?: string; artist?: string }> {
  try {
    // ID3v2 tags live at the very start of the file; reading the first
    // ~1MB comfortably covers all but the most bloated tags (embedded art).
    const head = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
    if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};

    const majorVersion = head[3];
    const flags = head[5]!;
    const tagSize = synchsafeToInt(head.subarray(6, 10));
    let offset = 10;
    if (flags & 0x40) {
      // Extended header present — its size is itself synchsafe (v2.4) or a
      // plain 32-bit value (v2.3); skip it either way.
      if (offset + 4 > head.length) return {};
      const extSize = majorVersion === 4 ? synchsafeToInt(head.subarray(offset, offset + 4)) : new DataView(head.buffer, head.byteOffset + offset, 4).getUint32(0);
      offset += extSize;
    }
    const end = Math.min(10 + tagSize, head.length);

    let title: string | undefined;
    let artist: string | undefined;

    if (majorVersion === 2) {
      // ID3v2.2: 3-char frame ids, 3-byte sizes, 6-byte frame headers.
      while (offset + 6 <= end) {
        const id = new TextDecoder("ascii").decode(head.subarray(offset, offset + 3));
        if (id === "\u0000\u0000\u0000") break;
        const size = (head[offset + 3]! << 16) | (head[offset + 4]! << 8) | head[offset + 5]!;
        const frameStart = offset + 6;
        if (size <= 0 || frameStart + size > end) break;
        const frameBytes = head.subarray(frameStart, frameStart + size);
        if (id === "TT2") title = decodeFrameText(frameBytes);
        else if (id === "TP1") artist = decodeFrameText(frameBytes);
        offset = frameStart + size;
      }
    } else {
      // ID3v2.3 / ID3v2.4: 4-char frame ids, 4-byte sizes (synchsafe in
      // v2.4, plain big-endian in v2.3), 10-byte frame headers.
      while (offset + 10 <= end) {
        const id = new TextDecoder("ascii").decode(head.subarray(offset, offset + 4));
        if (id === "\u0000\u0000\u0000\u0000") break;
        const sizeBytes = head.subarray(offset + 4, offset + 8);
        const size = majorVersion === 4 ? synchsafeToInt(sizeBytes) : new DataView(head.buffer, head.byteOffset + offset + 4, 4).getUint32(0);
        const frameStart = offset + 10;
        if (size <= 0 || frameStart + size > end) break;
        const frameBytes = head.subarray(frameStart, frameStart + size);
        if (id === "TIT2") title = decodeFrameText(frameBytes);
        else if (id === "TPE1") artist = decodeFrameText(frameBytes);
        offset = frameStart + size;
      }
    }

    return { title: title || undefined, artist: artist || undefined };
  } catch {
    return {};
  }
}

/** Same "Artist - Title" filename convention the server falls back to, used
 * so the upload modal has a sensible guess even before/without ID3 tags. */
export function titleFromFilename(filename: string): { artist: string; title: string } {
  const base = filename.replace(/\.[^./]+$/, "").replace(/[_]+/g, " ").trim();
  const idx = base.indexOf(" - ");
  if (idx > 0) return { artist: base.slice(0, idx).trim(), title: base.slice(idx + 3).trim() };
  return { artist: "", title: base || "" };
}
