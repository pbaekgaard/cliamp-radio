import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
// Precomputed bcrypt hash for the default password "changeme" — override via env in production.
const ADMIN_PASSWORD_HASH =
  process.env.ADMIN_PASSWORD_HASH ||
  "$2b$10$eOIWRVvKVMQi83EclQLOYubhFTl54TdHnMJLO4pvpMrDqV77FnYcm";

export const SESSION_COOKIE = "cliamp_session";

export async function verifyCredentials(username: string, password: string) {
  if (username !== ADMIN_USERNAME) return false;
  return bcrypt.compare(password, ADMIN_PASSWORD_HASH);
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
