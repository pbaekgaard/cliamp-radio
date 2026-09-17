# cliamp-radio

A self-hosted internet radio server: define stations as playlists of stream
URLs, serve them as M3U files, and manage everything from a web UI with a
live globe of who's listening right now.

## Stack

- **Server**: [Bun](https://bun.sh) + TypeScript, no framework — just
  `Bun.serve`. Serves the station M3U endpoints, a JSON API, and the built
  React client.
- **Client**: React + Vite. The listener globe is a plain 2D `<canvas>`
  rendered with a [`d3-geo`](https://github.com/d3/d3-geo) orthographic
  projection over a bundled [world-atlas](https://github.com/topojson/world-atlas)
  topojson (no WebGL/Three.js, no third-party CDN at runtime — inspired by
  [cliamp.stream](https://github.com/bjarneo/cliamp)'s own globe).
- **Auth**: single admin account (env-configured username + bcrypt password
  hash), JWT session cookie.
- **Listener geolocation**: [`geoip-lite`](https://github.com/geoip-lite/node-geoip)
  — local IP→city/country lookup, no third-party calls at request time.
- **Auto-update**: polls the GitHub Releases API for this repo; the web UI
  shows a pulsing "Update available" pill with the release notes and an
  **Install update** button that runs `scripts/update.sh` (git checkout latest
  tag → reinstall deps → rebuild client → restart the systemd service).

## Project layout

```
server/         Bun/TypeScript backend (API + station streaming + static client)
  data/stations/ JSON station definitions (name + slug + tracks)
client/         React/Vite frontend (globe, login, dashboard)
scripts/update.sh   In-place update script used by the "Install update" button
systemd/cliamp-radio.service   Example unit file
```

## Running locally

```bash
# Backend (http://localhost:8000)
cd server && bun install && bun run dev

# Frontend dev server (proxies /api and /cliamp-radio to :8000)
cd client && bun install && bun run dev
```

For production, build the client once and let the Bun server serve it:

```bash
cd client && bun install && bun run build
cd ../server && bun install && bun run start
```

Or simply use `./start.sh --prod` from the repo root, which does both steps.

### Exposing it directly on a low port (80/443) without a reverse proxy

The server reads `PORT` from the environment (defaults to `8000`). If you
just want plain HTTP on port 80 with no TLS:

```bash
sudo PORT=80 ./start.sh --prod
# or, without needing root each time:
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v bun)")"
PORT=80 ./start.sh --prod
```

### HTTPS (recommended): put Caddy in front

For real deployments, run the app on its default port `8000` and put
[Caddy](https://caddyserver.com) in front of it — it gets you a free,
auto-renewing Let's Encrypt certificate and HTTP→HTTPS redirect with almost
no config.

```bash
# Install Caddy (Debian/Ubuntu)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Point Caddy at cliamp-radio — edit the domain in deploy/Caddyfile first
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Then run the app normally on 8000 (`./start.sh --prod`, or via the systemd
unit below). Make sure ports 80 *and* 443 are allowed both in your cloud
provider's firewall/security list **and** in the instance's own `iptables`
(some cloud images, e.g. OCI's Ubuntu image, default to rejecting everything
but SSH):

```bash
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # persist across reboots (apt install iptables-persistent if needed)
```

Caddy needs 80 briefly for the ACME HTTP challenge (then redirects to 443),
so both ports must be open even though the app itself is only reachable via
Caddy on 443.

## Admin login & password

The first time the server runs, it creates `server/data/admin-credentials.json`
(gitignored — never touched by `git pull`/updates) with username `admin` and
password `changeme`. Logging in with that default password immediately shows
a mandatory "set a new password" prompt — you can't use the dashboard until
you change it. From then on your chosen password is what's stored in that
file and persists across every future update/restart.

`ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` env vars are only consulted on the
very first boot (before that file exists), to let you provision a non-default
password/username up front instead of using `changeme`. Once the credentials
file exists, those env vars are ignored — the file is the source of truth.

## Configuration (environment variables)

| Variable              | Purpose                                                   | Default          |
| --------------------- | ---------------------------------------------------------- | ----------------- |
| `PORT`                | HTTP port                                                  | `8000`            |
| `ADMIN_USERNAME`      | Initial admin username (first boot only — see above)      | `admin`           |
| `ADMIN_PASSWORD_HASH` | bcrypt hash for the initial admin password (first boot only) | hash of `changeme`, forces a password change on first login |
| `JWT_SECRET`          | Secret used to sign session cookies                        | auto-generated & persisted on first boot (see below) |
| `APP_VERSION`         | Version this deployment reports as "current"               | `0.0.0`           |
| `GITHUB_REPO`         | `owner/repo` to check for releases                         | `pbaekgaard/cliamp-radio` |

Generate a password hash (only needed if you want to skip the forced
first-login password change):

```bash
cd server && bun -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

`JWT_SECRET` has no built-in default — if you don't set it, the server
generates a random 384-bit secret the first time it boots and saves it to
`server/data/jwt-secret.txt` (gitignored, `0600` permissions, never touched
by `git pull`/updates), so sessions survive restarts without you having to
manage a secret by hand. You only need to set the env var yourself if you
want a specific/shared value (e.g. running multiple instances behind a load
balancer that all need to accept each other's session cookies). Either way,
keep whatever value ends up in use private — anyone who has it can forge
admin session cookies.

## Adding stations

Log in at `/login`, then use the dashboard at `/dashboard` to add/edit/delete
stations and their tracks. Each station is served as an M3U playlist at
`/cliamp-radio/<slug>.m3u`, ready to hand to cliamp or any player that
understands M3U.

### YouTube playlist tracks become a shared live stream

If a track's URL is a YouTube playlist (or "Radio" mix) link — anything with
a `list=` param, e.g. `https://www.youtube.com/playlist?list=PL...` — the
station's M3U doesn't hand out that raw YouTube URL. Instead it's rewritten
to `/cliamp-radio/live/<playlistId>.mp3`, a stream generated and hosted by
this server itself:

- The playlist's videos are pulled one at a time with
  [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), transcoded to MP3 with
  `ffmpeg`, played back in **shuffled order on an infinite loop** (reshuffled
  every time it runs out), and broadcast to every connected listener at the
  same playback position — like a real radio station, not a personal
  playlist that restarts from track one each time someone tunes in. That's
  what lets you send a station's URL to a friend and listen along together.
- ICY `StreamTitle` metadata is updated per-track with a best-effort
  "Artist - Title" (parsed from the video title, falling back to the
  channel/uploader name), so any player that understands Icecast/Shoutcast
  "now playing" metadata (most of them) shows what's currently playing.
- The stream only runs while at least one listener is connected — it starts
  on the first request and stops itself 5 minutes after the last listener
  leaves — and the playlist's video list is periodically refreshed (every 6
  hours) to pick up additions/removals.
- **Requires `yt-dlp` and `ffmpeg` to be installed** on the machine running
  the server (`apt install ffmpeg`, and see the
  [yt-dlp install docs](https://github.com/yt-dlp/yt-dlp#installation)).
  Plain (non-playlist) YouTube video links are unaffected and still play
  directly as before.
- **YouTube may block a server's IP outright** with `Sign in to confirm
  you're not a bot`, especially on datacenter/VPS IPs — this is YouTube
  bot-detection, not a bug in this app, and there's no way to make it 100%
  hands-off forever (that would require an always-valid signed-in Google
  session, which only Google controls the lifetime of). Two things help:
  1. **Install a JS runtime** (yt-dlp uses it to solve YouTube's player
     challenges/PO tokens). [Deno](https://deno.com) is the one yt-dlp looks
     for by default: `curl -fsSL https://deno.land/install.sh | sh`, then
     make sure `deno` ends up on the same `PATH` the `cliamp-radio` service
     uses (e.g. symlink it into `/usr/local/bin`).
  2. **Give yt-dlp cookies from a real, signed-in YouTube session.** Two
     options, from least to most maintenance:

     - **`YTDLP_COOKIES_FROM_BROWSER` (recommended)** — point at a real
       browser profile on the server that's logged into a Google account,
       and yt-dlp reads cookies live from it on every single request. Set
       up once, no manual re-export ever:
       ```bash
       # One-time setup on the server:
       sudo apt install -y chromium-browser   # or chromium, depending on distro
       mkdir -p server/data/yt-browser-profile
       # Log into YouTube inside that profile once. If the server has no
       # display, do this over SSH with X11 forwarding (ssh -X) or a
       # throwaway VNC session:
       chromium-browser --user-data-dir="$(pwd)/server/data/yt-browser-profile" https://accounts.google.com
       # Sign in, then close the browser once you're logged in.
       ```
       Then set (already scaffolded, commented-out, by `install_systemd.sh`):
       ```ini
       Environment=YTDLP_COOKIES_FROM_BROWSER=chromium:/full/path/to/server/data/yt-browser-profile
       ```
       and `sudo systemctl daemon-reload && sudo systemctl restart cliamp-radio`.
       This keeps working for as long as that Google session stays valid —
       typically months — with zero SSH visits in between. If Google ever
       forces a fresh interactive sign-in (rare, but possible on any
       account), you'll need to repeat the one-time login step above; no
       automation can avoid that particular case.
     - **`YTDLP_COOKIES_FILE`** — a static Netscape-format `cookies.txt`
       exported from a browser via an extension like
       ["Get cookies.txt LOCALLY"](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc).
       Simpler to set up but it's a point-in-time snapshot that will
       eventually go stale and need manually re-exporting/copying to the
       server — only use this if a persistent browser profile isn't
       practical for you.

  3. **(Optional, recommended alongside `YTDLP_COOKIES_FROM_BROWSER`) Keep
     the session itself warm automatically.** `scripts/cookie-refresh/`
     is a small standalone Playwright script that periodically opens the
     *same* browser profile and just visits youtube.com for a few seconds,
     like an ordinary person would. It prefers real Google Chrome
     (Playwright's `channel: "chrome"`) when available, but auto-detects a
     system Chromium install as a fallback — useful since **Google doesn't
     publish official Chrome builds for Linux ARM**, so ARM servers (e.g.
     `uname -m` says `aarch64`/`arm64`) need Chromium instead. Run on a
     timer, this reduces (doesn't eliminate — nothing can) how often
     Google's session ever expires or asks for a fresh interactive sign-in:
     ```bash
     # One-time setup on the server — pick whichever applies:
     sudo apt install -y google-chrome-stable   # x86_64: needs Google's own apt repo/deb, not always in default apt
     sudo apt install -y chromium-browser        # ARM (or if Chrome isn't available): a real, JS-executing browser too
     cd scripts/cookie-refresh && bun install

     # One-time login (same profile YTDLP_COOKIES_FROM_BROWSER points at).
     # Needs a display — use ssh -X or a throwaway VNC session:
     bun run login
     # A visible Chrome/Chromium window opens to accounts.google.com. Sign
     # in, then just close the window — the script exits on its own.

     # Install the keep-alive timer (runs every ~12h + jitter from then on):
     sudo ./install_cookie_refresh_timer.sh
     ```
     The script auto-detects Chrome/Chromium at common install paths (or
     set `CHROME_EXECUTABLE_PATH` to point at a specific binary yourself).
     Whichever it uses, it's still a real, full browser — what matters for
     keeping cookies/sessions valid is that it actually renders pages and
     runs JS like a normal visit, not which specific browser brand it is.
     If you'd rather skip this automation, everything above still works
     fine without it; you'll just need to repeat the manual login a bit
     more often.

A built-in **"All Stations"** playlist (`/cliamp-radio/all.m3u`) is always
available and automatically kept in sync — it's the union of every other
station's tracks with duplicates (matched by stream URL) removed. It's
generated on the fly, shown read-only in the dashboard, and can't be edited,
renamed, or deleted (the name "All" is reserved). Each station's tracks are
preceded by a `---- Station Name ----` divider entry (an inert placeholder
track pointing at `https://cliamp-radio.invalid/divider` — a real-looking
stream URL on the `.invalid` TLD, which RFC 2606 guarantees will never
resolve, so it "plays" but errors out immediately) so you can tell where each
station's tracks start while browsing/skipping through the combined
playlist.

The public globe page (`/`) also lists every station with a **Copy config**
button next to it — it copies a ready-to-paste `[[station]]` block (with the
right `name`/`url` for your own deployment's hostname) straight into your
cliamp `radios.toml`. A **Copy all** button above the list copies every
station's block at once, for a one-shot `radios.toml` setup.

Below the station list, a live globe shows current listeners as dots
(canvas + d3-geo, see above), and a stats panel next to it shows the top
countries listening right now (falling back to all-time top countries when
nobody's currently tuned in), the busiest station, peak concurrent listeners,
total sessions, total hours streamed, and a bar chart of listening hours for
the last 31 days. All of this is computed live on the server from each
listener's playlist requests — see `server/lib/listeners.ts` — and persisted
to `server/data/listen-history.jsonl` (git-ignored) so the all-time numbers
survive restarts/updates.

## Deploying with systemd + auto-update

One-time setup — from the repo directory on your server:

```bash
sudo ./scripts/install_systemd.sh          # infers the service user (or: ./scripts/install_systemd.sh someuser)
```

This builds the client, writes `/etc/systemd/system/cliamp-radio.service`
(pointing at this exact checkout and your `bun` binary), grants the service
user passwordless `sudo systemctl restart cliamp-radio` (so the in-app
"Install update" button works without a prompt), then enables and starts the
service. The unit file lives outside this git repo, so it's never touched or
reset by `git pull` or an update — you only need to run this once.

After that, set up HTTPS with [Caddy](#https-recommended-put-caddy-in-front)
(see above). `JWT_SECRET` doesn't need any manual setup — see
[Configuration](#configuration-environment-variables) — but you can still
uncomment/set it in `/etc/systemd/system/cliamp-radio.service` if you want to
pin a specific value (e.g. sharing one secret across multiple instances),
then `sudo systemctl daemon-reload && sudo systemctl restart cliamp-radio`.

To release an update: tag and push (`git tag v1.0.1 && git push --tags`) —
GitHub Actions publishes a Release, and every running instance picks it up on
its next poll and shows the update prompt in the UI.

(`systemd/cliamp-radio.service` in this repo is kept as a reference/template
if you'd rather wire up the unit by hand instead of using the installer
script.)

## Releasing a new version

Push a tag matching `v*.*.*` and the `Release` workflow
(`.github/workflows/release.yml`) auto-generates a GitHub Release with notes
from the commits since the last tag.
