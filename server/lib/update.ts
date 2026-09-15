import { spawn } from "node:child_process";
import path from "node:path";

const REPO = process.env.GITHUB_REPO || "pbaekgaard/cliamp-radio";
const REPO_ROOT = path.join(import.meta.dir, "..", "..");

interface ReleaseInfo {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
}

let cachedRelease: ReleaseInfo | null = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

export function getCurrentVersion(): string {
  return process.env.APP_VERSION || "0.0.0";
}

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const now = Date.now();
  if (cachedRelease && now - cachedAt < CACHE_MS) return cachedRelease;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "cliamp-radio-updater" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  cachedRelease = {
    tagName: data.tag_name,
    name: data.name || data.tag_name,
    body: data.body || "",
    htmlUrl: data.html_url,
    publishedAt: data.published_at,
  };
  cachedAt = now;
  return cachedRelease;
}

function normalizeTag(tag: string): string {
  return tag.replace(/^v/, "");
}

export async function checkForUpdate() {
  const latest = await fetchLatestRelease();
  const current = getCurrentVersion();
  if (!latest) {
    return { current, updateAvailable: false, latest: null };
  }
  const updateAvailable = normalizeTag(latest.tagName) !== normalizeTag(current);
  return { current, updateAvailable, latest };
}

export function runUpdate(): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    const script = path.join(REPO_ROOT, "scripts", "update.sh");
    const child = spawn("bash", [script], { cwd: REPO_ROOT });
    let log = "";
    child.stdout.on("data", (d) => (log += d.toString()));
    child.stderr.on("data", (d) => (log += d.toString()));
    child.on("close", (code) => {
      cachedRelease = null; // force re-check next time
      resolve({ ok: code === 0, log });
    });
  });
}
