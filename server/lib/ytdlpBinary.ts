import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// yt-dlp has to keep pace with YouTube's ever-changing player JS: a copy
// that's a couple of months old starts failing with "n challenge solving
// failed" / "The page needs to be reloaded", and every uncached track gets
// skipped. A pip/apt install can't reliably be upgraded from here (permission
// and PEP 668 issues), so the server keeps its own standalone release binary
// under data/bin, which bundles the challenge solver and can update itself
// with `-U`. The system yt-dlp is only a fallback until the download succeeds.
// Set YTDLP_PATH to pin a specific binary and turn this management off.

const PINNED = process.env.YTDLP_PATH || null;
const BIN_DIR = path.join(import.meta.dir, "..", "data", "bin");
const MANAGED_PATH = path.join(BIN_DIR, "yt-dlp");
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

let managedReady = !PINNED && existsSync(MANAGED_PATH);

/** The yt-dlp executable every spawn should use. */
export function ytdlpBin(): string {
  if (PINNED) return PINNED;
  return managedReady ? MANAGED_PATH : "yt-dlp";
}

function releaseAsset(): string | null {
  if (process.platform === "linux") {
    if (process.arch === "x64") return "yt-dlp_linux";
    if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
    return null;
  }
  if (process.platform === "darwin") return "yt-dlp_macos";
  return null;
}

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { ok: code === 0, out: (out + err).trim() };
}

async function download(asset: string): Promise<void> {
  await mkdir(BIN_DIR, { recursive: true });
  const tmp = `${MANAGED_PATH}.download`;
  const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await Bun.write(tmp, res);
  await chmod(tmp, 0o755);
  const check = await run([tmp, "--version"]);
  if (!check.ok) {
    await rm(tmp, { force: true });
    throw new Error(`downloaded binary doesn't run: ${check.out}`);
  }
  await rename(tmp, MANAGED_PATH);
  console.log(`[yt-dlp] installed standalone yt-dlp ${check.out} at ${MANAGED_PATH}`);
}

let inFlight: Promise<void> | null = null;

/** Installs the managed binary if missing, otherwise self-updates it. Never throws. */
export function refreshYtdlp(): Promise<void> {
  if (PINNED) return Promise.resolve();
  const asset = releaseAsset();
  if (!asset) return Promise.resolve();
  inFlight ??= (async () => {
    try {
      if (!existsSync(MANAGED_PATH)) {
        await download(asset);
      } else {
        const res = await run([MANAGED_PATH, "-U"]);
        if (!res.ok) throw new Error(res.out);
        if (!/up to date/i.test(res.out)) console.log(`[yt-dlp] ${res.out}`);
      }
      managedReady = true;
    } catch (err) {
      console.error(`[yt-dlp] couldn't install/update the managed yt-dlp (falling back to ${ytdlpBin()}):`, err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Refreshes at boot and then periodically. */
export function startYtdlpUpdater(): void {
  void refreshYtdlp();
  setInterval(() => void refreshYtdlp(), REFRESH_INTERVAL_MS).unref?.();
}
