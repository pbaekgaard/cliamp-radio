import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CREDENTIALS_DIR = path.join(import.meta.dir, "..", "data");
const JWT_SECRET_PATH = path.join(CREDENTIALS_DIR, "jwt-secret.txt");

// Session-signing secret. There is deliberately NO hardcoded fallback value
// here (a shared, public default baked into the repo would let anyone who's
// ever read this source forge admin session cookies against any deployment
// that forgot to override it). Instead:
//   1. JWT_SECRET env var, if set — lets you pin/rotate/share a secret
//      explicitly (e.g. across multiple instances behind a load balancer).
//   2. Otherwise, a random 384-bit secret is generated on first boot and
//      persisted to server/data/jwt-secret.txt (gitignored, mode 0600, never
//      touched by `git pull`/updates) so it survives restarts but a fresh
//      one is generated per-deployment automatically — no manual step, and
//      nothing secret ever lives in this repo.
function loadOrCreateJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (existsSync(JWT_SECRET_PATH)) {
    const existing = readFileSync(JWT_SECRET_PATH, "utf-8").trim();
    if (existing) return existing;
  }
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  const secret = randomBytes(48).toString("hex");
  writeFileSync(JWT_SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

const JWT_SECRET = loadOrCreateJwtSecret();
export { JWT_SECRET };

// Admin credentials persist here — deliberately NOT in the JWT secret / env
// vars and gitignored, so a `git pull`/update never resets a password you've
// already changed. Only the very first boot (no file yet) falls back to
// ADMIN_USERNAME/ADMIN_PASSWORD_HASH env vars or the "changeme" default.
const CREDENTIALS_PATH = path.join(CREDENTIALS_DIR, "admin-credentials.json");

// bcrypt hash of "changeme"
const DEFAULT_PASSWORD_HASH = "$2b$10$eOIWRVvKVMQi83EclQLOYubhFTl54TdHnMJLO4pvpMrDqV77FnYcm";

export const SESSION_COOKIE = "cliamp_session";


interface Credentials {
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
}

let cache: Credentials | null = null;

async function loadCredentials(): Promise<Credentials> {
  if (cache) return cache;
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf-8");
    cache = JSON.parse(raw) as Credentials;
    return cache;
  } catch {
    // First boot: bootstrap from env vars if provided, otherwise the default
    // "changeme" password, which forces a change on first login.
    const envHash = process.env.ADMIN_PASSWORD_HASH;
    const bootstrap: Credentials = {
      username: process.env.ADMIN_USERNAME || "admin",
      passwordHash: envHash || DEFAULT_PASSWORD_HASH,
      mustChangePassword: !envHash,
    };
    await saveCredentials(bootstrap);
    return bootstrap;
  }
}

async function saveCredentials(creds: Credentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  cache = creds;
}

export async function verifyCredentials(
  username: string,
  password: string
): Promise<{ ok: boolean; mustChangePassword: boolean }> {
  const creds = await loadCredentials();
  if (username !== creds.username) return { ok: false, mustChangePassword: false };
  const ok = await bcrypt.compare(password, creds.passwordHash);
  return { ok, mustChangePassword: ok && creds.mustChangePassword };
}

export async function getMustChangePassword(username: string): Promise<boolean> {
  const creds = await loadCredentials();
  return creds.username === username && creds.mustChangePassword;
}

export async function changePassword(
  username: string,
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const creds = await loadCredentials();
  if (username !== creds.username) return { ok: false, error: "not found" };
  const valid = await bcrypt.compare(currentPassword, creds.passwordHash);
  if (!valid) return { ok: false, error: "current password is incorrect" };
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: "new password must be at least 8 characters" };
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await saveCredentials({ username, passwordHash, mustChangePassword: false });
  return { ok: true };
}

export function createSessionToken(username: string): string {
  return jwt.sign({ sub: username, kind: "admin" }, JWT_SECRET, { expiresIn: "7d" });
}

// Admin and WorkFM identity tokens (see workfmIdentity.ts) are both signed
// with this same JWT_SECRET, so without a discriminator a valid WorkFM
// identity token — trivially obtainable by anyone, no password required —
// could simply be copied into the admin session cookie and would verify
// successfully here, granting admin access to anyone who names themselves
// anything in WorkFM. The `kind` claim keeps the two token types from
// ever being interchangeable, even though they share a secret.
export function verifySessionToken(token: string | undefined): { sub: string } | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; kind?: string };
    if (payload.kind !== "admin" || !payload.sub) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export function getTokenFromRequest(req: Request): string | undefined {
  const cookieHeader = req.headers.get("cookie") || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return match?.split("=")[1];
}

export function requireAuth(req: Request): { sub: string } | null {
  return verifySessionToken(getTokenFromRequest(req));
}
