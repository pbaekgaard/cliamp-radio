// Keeps a real, signed-in Google Chrome session warm so yt-dlp can read
// live cookies from it (via YTDLP_COOKIES_FROM_BROWSER) without ever going
// stale. This drives an *actual* installed Google Chrome through Playwright
// — not a bare HTTP client like yt-dlp itself — so from YouTube's point of
// view this looks like an ordinary person periodically visiting the site,
// which is exactly what keeps a session's cookies alive and unflagged.
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

import path from "node:path";
import { chromium } from "playwright-core";

const PROFILE_DIR = path.join(import.meta.dir, "..", "..", "server", "data", "yt-browser-profile");
const isLogin = process.argv.includes("--login");

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome", // use the real, system-installed Google Chrome, not Playwright's bundled Chromium
    headless: !isLogin,
    viewport: { width: 1280, height: 800 },
  });

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
