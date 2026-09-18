import { WorkFmQueueStream } from "./workfmQueue";

// ---------------------------------------------------------------------------
// WorkFM rooms: user-created, independent request-queue "channels" — each
// one wraps its own WorkFmQueueStream (see workfmQueue.ts for the actual
// queue/playback engine). This lets different groups (e.g. different rooms
// at an office) each run their own WorkFM instance instead of sharing one
// global queue. Rooms are entirely in-memory; an admin can remove one at
// any time (see removeWorkFmRoom), and a periodic sweep (see
// startWorkFmRoomSweeper) also auto-removes any room nobody's listening to
// once it's been empty for EMPTY_ROOM_GRACE_MS.
// ---------------------------------------------------------------------------

const MAX_ROOMS = 50; // sane upper bound so rooms can't be spammed into unbounded memory
const MAX_ROOM_NAME_LENGTH = 40;
// How long a room's audio stream can sit with zero listeners (see
// WorkFmQueueStream.emptySince) before the sweep auto-removes it — long
// enough that a creator setting up their queue before hitting "Listen"
// doesn't get swept out from under them.
const EMPTY_ROOM_GRACE_MS = 2 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

export interface WorkFmRoom {
  slug: string;
  name: string;
  createdAt: number;
  createdBy: string;
  stream: WorkFmQueueStream;
}

export interface WorkFmRoomSummary {
  slug: string;
  name: string;
  createdAt: number;
  createdBy: string;
  members: number;
  nowPlaying: WorkFmQueueStream["status"]["nowPlaying"];
  queueLength: number;
}

const rooms = new Map<string, WorkFmRoom>();

function slugifyRoomName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function summarize(room: WorkFmRoom): WorkFmRoomSummary {
  const status = room.stream.status;
  return {
    slug: room.slug,
    name: room.name,
    createdAt: room.createdAt,
    createdBy: room.createdBy,
    members: status.members,
    nowPlaying: status.nowPlaying,
    queueLength: status.queueLength,
  };
}

/** All active rooms, newest first. */
export function listWorkFmRooms(): WorkFmRoomSummary[] {
  return [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map(summarize);
}

export function getWorkFmRoom(slug: string): WorkFmRoom | null {
  return rooms.get(slug) ?? null;
}

/** Creates a new room and immediately starts its playback loop so it's
 * ready the instant someone queues a first track. Throws on invalid/
 * duplicate names or once MAX_ROOMS is hit. */
export function createWorkFmRoom(rawName: string, createdBy: string): WorkFmRoom {
  const name = rawName.trim().replace(/\s+/g, " ").slice(0, MAX_ROOM_NAME_LENGTH);
  if (!name) throw new Error("a room name is required");
  const slug = slugifyRoomName(name);
  if (!slug) throw new Error("that name doesn't produce a valid room — try letters or numbers");
  if (rooms.has(slug)) throw new Error(`a room called "${name}" already exists`);
  if (rooms.size >= MAX_ROOMS) throw new Error("too many rooms are open right now — try again once one closes");

  const stream = new WorkFmQueueStream();
  stream.start();
  const room: WorkFmRoom = { slug, name, createdAt: Date.now(), createdBy, stream };
  rooms.set(slug, room);
  return room;
}

/** Stops every room's playback — called on process shutdown. */
export function stopAllWorkFmRooms() {
  for (const room of rooms.values()) room.stream.stop();
}

/** Admin-only: permanently removes a room and tears down its stream/queue.
 * Returns false if no such room exists. */
export async function removeWorkFmRoom(slug: string): Promise<boolean> {
  const room = rooms.get(slug);
  if (!room) return false;
  rooms.delete(slug);
  await room.stream.destroy();
  return true;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Tears down any room whose audio stream has had zero listeners for at
 * least EMPTY_ROOM_GRACE_MS — i.e. nobody's actually around anymore. */
function sweepEmptyRooms() {
  const now = Date.now();
  for (const [slug, room] of rooms) {
    const emptySince = room.stream.emptySince;
    if (emptySince === null || now - emptySince < EMPTY_ROOM_GRACE_MS) continue;
    rooms.delete(slug);
    room.stream
      .destroy()
      .catch((err) => console.error(`[workfm-rooms] failed to tear down empty room "${slug}":`, err));
  }
}

/** Starts the periodic sweep that auto-removes empty rooms (see
 * sweepEmptyRooms) — call once at server startup; safe to call repeatedly. */
export function startWorkFmRoomSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepEmptyRooms, SWEEP_INTERVAL_MS);
}
