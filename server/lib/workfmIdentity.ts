import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { JWT_SECRET } from "./auth";

// WorkFM's queue is public (no admin account needed to use it) — this is
// deliberately *not* the admin auth system in auth.ts. It just lets someone
// pick a display name once ("identify"), remembered for a while in a
// cookie, so the queue can show who requested each track without asking
// for a password or building real user accounts.
export const WORKFM_SESSION_COOKIE = "workfm_identity";
const MAX_NAME_LENGTH = 24;

export function normalizeWorkFmName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, "");
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

/** `id` is a stable, opaque per-session identity — minted once and carried
 * forward across renames (see index.ts's /identify handler, which reuses
 * the caller's existing `id` if they already have a session rather than
 * generating a new one). This is what lets a rename retroactively update
 * that same person's past chat messages (see
 * WorkFmRoomStream.renameChatAuthor) without trusting the display name
 * itself, which anyone can freely change or collide with someone else's. */
export function createWorkFmSessionToken(name: string, id: string = randomUUID()): string {
  return jwt.sign({ sub: name, id, kind: "workfm" }, JWT_SECRET, { expiresIn: "30d" });
}

function verifyWorkFmSessionToken(token: string | undefined): { name: string; id: string } | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; id?: string; kind?: string };
    if (payload.kind !== "workfm" || !payload.sub) return null;
    // Sessions minted before `id` existed don't have one — treat each as
    // its own identity going forward rather than erroring, since there's
    // nothing meaningful to recover.
    return { name: payload.sub, id: payload.id ?? randomUUID() };
  } catch {
    return null;
  }
}

export function getWorkFmIdentity(req: Request): { name: string; id: string } | null {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${WORKFM_SESSION_COOKIE}=`));
  const token = match?.split("=")[1];
  return verifyWorkFmSessionToken(token);
}
