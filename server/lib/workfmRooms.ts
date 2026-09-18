import { WorkFmQueueStream } from "./workfmQueue";

// ---------------------------------------------------------------------------
// WorkFM: a single, always-on request-queue "room" shared by everyone (see
// workfmQueue.ts for the actual queue/playback engine). WorkFM used to let
// anyone spin up their own independent room; that's been removed in favor
// of one persistent room, so there's nothing to create, list, or clean up.
// ---------------------------------------------------------------------------

export const WORKFM_ROOM_SLUG = "workfm";
const WORKFM_ROOM_NAME = "Radio Bækgaard";

export interface WorkFmRoom {
  slug: string;
  name: string;
  stream: WorkFmQueueStream;
}

const workfmRoom: WorkFmRoom = {
  slug: WORKFM_ROOM_SLUG,
  name: WORKFM_ROOM_NAME,
  stream: new WorkFmQueueStream(),
};

/** Starts the room's playback loop — call once at server startup. */
export function startWorkFmRoom() {
  workfmRoom.stream.start();
}

/** Returns the single persistent WorkFM room, or null if `slug` doesn't
 * match it — kept so callers can still 404 on an unrecognized slug. */
export function getWorkFmRoom(slug: string): WorkFmRoom | null {
  return slug === WORKFM_ROOM_SLUG ? workfmRoom : null;
}

/** Stops the room's playback — called on process shutdown. */
export function stopWorkFmRoom() {
  workfmRoom.stream.stop();
}
