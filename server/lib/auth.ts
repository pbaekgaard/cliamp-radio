import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// Admin credentials persist here — deliberately NOT in the JWT secret / env
// vars and gitignored, so a `git pull`/update never resets a password you've
// already changed. Only the very first boot (no file yet) falls back to
// ADMIN_USERNAME/ADMIN_PASSWORD_HASH env vars or the "changeme" default.
const CREDENTIALS_DIR = path.join(import.meta.dir, "..", "data");
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
  return jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifySessionToken(token: string | undefined): { sub: string } | null {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string };
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
