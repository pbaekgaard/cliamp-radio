import jwt from "jsonwebtoken";
import { JWT_SECRET } from "./auth";

// DEIF FM's queue is public (no admin account needed to use it) — this is
// deliberately *not* the admin auth system in auth.ts. It just lets someone
// pick a display name once ("identify"), remembered for a while in a
// cookie, so the queue can show who requested each track without asking
// for a password or building real user accounts.
export const DEIF_SESSION_COOKIE = "deif_identity";
const MAX_NAME_LENGTH = 24;

export function normalizeDeifName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

export function createDeifSessionToken(name: string): string {
  return jwt.sign({ sub: name, kind: "deif" }, JWT_SECRET, { expiresIn: "30d" });
}

function verifyDeifSessionToken(token: string | undefined): { name: string } | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; kind?: string };
    if (payload.kind !== "deif" || !payload.sub) return null;
    return { name: payload.sub };
  } catch {
    return null;
  }
}

export function getDeifIdentity(req: Request): { name: string } | null {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${DEIF_SESSION_COOKIE}=`));
  const token = match?.split("=")[1];
  return verifyDeifSessionToken(token);
}
