// Keeps a real, signed-in browser session warm so yt-dlp can read live
// cookies from it (via YTDLP_COOKIES_FROM_BROWSER) without ever going stale.
// This drives an *actual* installed Chrome/Chromium through Playwright —
// not a bare HTTP client like yt-dlp itself — so from YouTube's point of
// view this looks like an ordinary person periodically visiting the site,
// which is exactly what keeps a session's cookies alive and unflagged.
//
// Prefers real Google Chrome (Playwright's "chrome" channel) when
// available, since that's the most ordinary-looking option — but Google
// doesn't ship official Chrome builds for Linux ARM, so on ARM servers this
// falls back to a system-installed Chromium instead (still a real,
// JS-executing browser; just not Google-branded). Override with
// CHROME_EXECUTABLE_PATH if auto-detection picks the wrong binary.
//
// Two modes:
//   bun run refresh.ts --login    Opens Chrome with a visible window so you
//                                 can sign in by hand, ONE TIME. Requires a
//                                 display (see README for ssh -X / VNC).
//                                 Waits until you close the window yourself.
//   bun run refresh.ts            Headless "keep-alive" visit: opens the
//                                 same profile, loads youtube.com, lingers
//                                 briefly, then exits. Meant to be run on a
//                                 timer (see ../install_cookie_refresh_timer.sh).
//
// Nothing here can complete the FIRST login for you — entering a password
// and clearing any 2FA/verification challenge has to be a real human action
// (scripting that would be both fragile and exactly the kind of behavior
// bot-detection exists to catch). This only keeps an already-established
// session alive for as long as possible afterwards.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const PROFILE_DIR = path.join(import.meta.dir, "..", "..", "server", "data", "yt-browser-profile");
const isLogin = process.argv.includes("--login");

// Common install locations for a real Chrome/Chromium binary, checked in
// order of preference (most ordinary-looking first). Snap-packaged
// Chromium on Ubuntu (chromium-browser -> /snap/bin/chromium) is common on
// ARM servers, where Google doesn't publish official Chrome builds at all.
const CANDIDATE_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
];

function resolveExecutablePath(): string | undefined {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined; // fall back to Playwright's own "chrome" channel resolution
}

async function main() {
  const executablePath = resolveExecutablePath();
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: !isLogin,
    viewport: { width: 1280, height: 800 },
    // Snap-confined Chromium (common on ARM Ubuntu servers) needs this to
    // launch under automation; harmless for a plain Chrome binary too.
    args: ["--no-sandbox"],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  } else {
    launchOptions.channel = "chrome"; // real, system-installed Google Chrome
  }
  console.log(`==> Using browser: ${executablePath ?? "Playwright 'chrome' channel"}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    if (isLogin) {
      console.log("==> Opening Google sign-in. Log in to the account you want yt-dlp to use, then");
      console.log("    just close the browser window when you're done — this script will exit on its own.");
      await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });
      // Wait for the user to close the window themselves rather than any
      // fixed timeout — logging in (and clearing any 2FA prompt) takes as
      // long as it takes.
      await new Promise<void>((resolve) => context.on("close", () => resolve()));
      return;
    }

    console.log("==> Visiting YouTube to keep the session warm…");
    await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
    // Linger a few seconds like a real visit would, rather than a
    // hit-and-run page load that itself could look automated.
    await page.waitForTimeout(4000 + Math.random() * 4000);
    console.log("==> Done.");
  } finally {
    if (!isLogin) await context.close();
  }
}

main().catch((err) => {
  console.error("[cookie-refresh] failed:", err);
  process.exit(1);
});
