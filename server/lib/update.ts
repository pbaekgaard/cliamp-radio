import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const REPO = process.env.GITHUB_REPO || "pbaekgaard/cliamp-radio";
const REPO_ROOT = path.join(import.meta.dir, "..", "..");
// Optional: set GITHUB_TOKEN (or GH_TOKEN) to a classic PAT with just
// "public_repo" scope to raise GitHub's REST API limit from 60/hour
// (unauthenticated, shared per server IP) to 5000/hour. Not required, but
// strongly recommended if update checks ever come back with checkFailed.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

interface ReleaseInfo {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
}

// The last release info we successfully fetched, kept around indefinitely
// (unlike cachedRelease below, which expires) so that a transient GitHub
// API failure (rate limit, network blip) can still serve a meaningful
// result instead of silently claiming "no update available".
let lastKnownGood: ReleaseInfo | null = null;

let cachedRelease: ReleaseInfo | null = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

let cachedVersion: string | null = null;

/**
 * The running version. Prefers an explicit APP_VERSION override (useful for
 * local dev / testing), otherwise derives it from the nearest git tag —
 * since update.sh always checks out an exact release tag, this reflects the
 * actually-installed version without needing anyone to remember to bump an
 * env var on every release. Cached for the process lifetime; a fresh value
 * is naturally picked up after the restart that follows every update.
 */
export function getCurrentVersion(): string {
  if (cachedVersion) return cachedVersion;
  if (process.env.APP_VERSION) {
    cachedVersion = process.env.APP_VERSION;
    return cachedVersion;
  }
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    cachedVersion = tag || "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

/**
 * Fetches a GitHub API URL, returning whether the call itself failed (bad
 * network, rate limit, 5xx, etc.) separately from "request succeeded but
 * returned nothing useful" — callers need to tell those apart so update
 * checks can report a real error instead of quietly claiming there's no
 * update.
 */
async function ghJson(url: string): Promise<{ data: any | null; error: boolean }> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "cliamp-radio-updater",
    };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return { data: null, error: true };
    }
    return { data: await res.json(), error: false };
  } catch {
    return { data: null, error: true };
  }
}

function parseVersion(tag: string): [number, number, number] | null {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

// We check plain git tags rather than GitHub "Releases" — releases are a
// separate object that has to be explicitly published (e.g. via `gh release
// create`), and it's easy to push a tag and forget that extra step, which
// would silently leave update-checking stuck on an old version forever.
// Tags are pushed as a normal part of `git push --tags`, so this is always
// in sync with what's actually on GitHub.
async function fetchLatestTag(): Promise<{ tag: { name: string; sha: string } | null; error: boolean }> {
  const { data: tags, error } = await ghJson(`https://api.github.com/repos/${REPO}/tags?per_page=100`);
  if (error) return { tag: null, error: true };
  if (!Array.isArray(tags) || tags.length === 0) return { tag: null, error: false };
  let best: { name: string; sha: string; v: [number, number, number] } | null = null;
  for (const t of tags) {
    const v = parseVersion(t.name);
    if (!v || !t.commit?.sha) continue;
    if (!best || compareVersions(v, best.v) > 0) best = { name: t.name, sha: t.commit.sha, v };
  }
  return { tag: best ? { name: best.name, sha: best.sha } : null, error: false };
}

async function fetchLatestReleaseFresh(): Promise<{ release: ReleaseInfo | null; error: boolean }> {
  const { tag, error } = await fetchLatestTag();
  if (error) return { release: null, error: true };
  if (!tag) return { release: null, error: false };

  // Annotated tags (`git tag -a`, which is how these are cut) carry a
  // message we can show as release notes; fall back to the commit message
  // for a plain/lightweight tag. Failures here are soft — we still have a
  // real tag/version to report, just without a nice changelog body.
  let body = "";
  let publishedAt = new Date().toISOString();
  const { data: ref } = await ghJson(`https://api.github.com/repos/${REPO}/git/refs/tags/${tag.name}`);
  if (ref?.object?.type === "tag" && ref.object.sha) {
    const { data: tagObj } = await ghJson(`https://api.github.com/repos/${REPO}/git/tags/${ref.object.sha}`);
    if (tagObj) {
      body = tagObj.message || "";
      publishedAt = tagObj.tagger?.date || publishedAt;
    }
  } else {
    const { data: commit } = await ghJson(`https://api.github.com/repos/${REPO}/commits/${tag.sha}`);
    if (commit) {
      body = commit.commit?.message || "";
      publishedAt = commit.commit?.committer?.date || publishedAt;
    }
  }

  return {
    release: {
      tagName: tag.name,
      name: tag.name,
      body,
      htmlUrl: `https://github.com/${REPO}/releases/tag/${tag.name}`,
      publishedAt,
    },
    error: false,
  };
}

/**
 * Returns the latest release plus whether this call reflects a real,
 * up-to-date look at GitHub (`error: false`) or fell back to previously
 * cached/known data because the live fetch failed (`error: true`) — e.g.
 * GitHub's unauthenticated REST API is capped at 60 requests/hour per IP,
 * which a busy server (or one sharing an IP/NAT with other traffic) can hit.
 * Silently reporting "no update" in that case would be indistinguishable
 * from actually being up to date, so callers need this signal.
 */
async function fetchLatestRelease(force = false): Promise<{ release: ReleaseInfo | null; error: boolean }> {
  const now = Date.now();
  if (!force && cachedRelease && now - cachedAt < CACHE_MS) return { release: cachedRelease, error: false };

  const fresh = await fetchLatestReleaseFresh();
  if (fresh.release) {
    cachedRelease = fresh.release;
    cachedAt = now;
    lastKnownGood = fresh.release;
    return { release: fresh.release, error: false };
  }
  if (fresh.error && lastKnownGood) {
    // Live check failed (rate limit / network) but we have a previous good
    // result — serve that rather than pretending there's nothing new.
    return { release: lastKnownGood, error: true };
  }
  return { release: null, error: fresh.error };
}

function normalizeTag(tag: string): string {
  return tag.replace(/^v/, "");
}

export async function checkForUpdate(force = false) {
  const { release: latest, error } = await fetchLatestRelease(force);
  const current = getCurrentVersion();
  if (!latest) {
    return { current, updateAvailable: false, latest: null, checkFailed: error };
  }
  const updateAvailable = normalizeTag(latest.tagName) !== normalizeTag(current);
  return { current, updateAvailable, latest, checkFailed: error };
}


/**
 * Whether upgrading from `fromSha` to `toSha` touched anything that could
 * possibly require the running process to restart. The client bundle is
 * served straight off disk on every request (see the static-file handler in
 * index.ts) with nothing cached in memory, so a release that only touches
 * `client/` takes effect for every visitor's *next* page load without the
 * server process itself needing to change at all — meaning WorkFM listeners
 * (and anyone else's live stream) are never interrupted for a client-only
 * release.
 *
 * The only files Bun actually has loaded into memory (and thus can't
 * hot-swap) are the server's own runtime source under `server/` — anything
 * else that might change in a release (README, AGENTS.md, .gitignore,
 * systemd unit templates, shell scripts under `scripts/` that get re-read
 * from disk fresh on every invocation, ...) is inert as far as the running
 * process is concerned, so it's safe to skip a restart for those too.
 * `server/data/` is excluded even though it's under `server/` since it's
 * runtime-generated state (uploads, saved credentials, history), never
 * imported code.
 */
function changedFilesRequireRestart(fromSha: string, toSha: string): boolean {
  if (!fromSha || !toSha || fromSha === toSha) return false;
  try {
    const out = execFileSync("git", ["diff", "--name-only", fromSha, toSha], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    const files = out.split("\n").map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) return false;
    return files.some((f) => f.startsWith("server/") && !f.startsWith("server/data/"));
  } catch {
    // Can't tell what changed (shallow clone, pruned history, ...) — restart
    // to be safe rather than risk running with mismatched server code.
    return true;
  }
}

export function runUpdate(): Promise<{ ok: boolean; log: string; restartRequired: boolean }> {
  return new Promise((resolve) => {
    const script = path.join(REPO_ROOT, "scripts", "update.sh");
    let fromSha = "";
    try {
      fromSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
    } catch {
      // Non-fatal — just means we can't compute a diff below and will
      // conservatively restart.
    }
    // SKIP_RESTART=1: the script must NOT restart the service itself — that
    // would kill this very process before it can respond to the HTTP
    // request that triggered it. We restart separately, after responding.
    const child = spawn("bash", [script], {
      cwd: REPO_ROOT,
      env: { ...process.env, SKIP_RESTART: "1" },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d.toString()));
    child.stderr.on("data", (d) => (log += d.toString()));
    child.on("close", (code) => {
      cachedRelease = null; // force re-check next time
      const ok = code === 0;
      let restartRequired = true;
      if (ok) {
        try {
          const toSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
          restartRequired = changedFilesRequireRestart(fromSha, toSha);
        } catch {
          restartRequired = true;
        }
        // A "soft" update (client-only changes) never restarts this process,
        // so getCurrentVersion()'s process-lifetime cache would otherwise
        // keep reporting the pre-update tag forever, making the update
        // banner falsely claim an update is still available. A hard update
        // restarts the process anyway, which naturally clears this cache,
        // so resetting it unconditionally here is safe either way.
        if (!restartRequired) cachedVersion = null;
      }
      resolve({ ok, log, restartRequired });
    });
  });
}

/**
 * Restarts the systemd service (if active) a moment after the caller has
 * finished writing the HTTP response, so the client actually receives the
 * update result before this process is killed by the restart.
 */
export function scheduleServiceRestart(delayMs = 750): void {
  setTimeout(() => {
    const child = spawn("bash", [
      "-c",
      "command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet cliamp-radio && sudo systemctl restart cliamp-radio || true",
    ]);
    child.unref();
  }, delayMs).unref();
}
