# cliamp-radio

A self-hosted internet radio server: define stations as playlists of stream
URLs, serve them as M3U files, and manage everything from a web UI with a
live globe of who's listening right now.

## Stack

- **Server**: [Bun](https://bun.sh) + TypeScript, no framework — just
  `Bun.serve`. Serves the station M3U endpoints, a JSON API, and the built
  React client.
- **Client**: React + Vite, [`react-globe.gl`](https://github.com/vasturiano/react-globe.gl)
  for the listener globe.
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
| `JWT_SECRET`          | Secret used to sign session cookies                        | dev default — **change this** |
| `APP_VERSION`         | Version this deployment reports as "current"               | `0.0.0`           |
| `GITHUB_REPO`         | `owner/repo` to check for releases                         | `pbaekgaard/cliamp-radio` |

Generate a password hash (only needed if you want to skip the forced
first-login password change):

```bash
cd server && bun -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

**Change `JWT_SECRET` before exposing this to the internet** — the dev
default is not safe for production. The admin password is handled by the
forced first-login change described above, so there's nothing else to
rotate manually.

## Adding stations

Log in at `/login`, then use the dashboard at `/dashboard` to add/edit/delete
stations and their tracks. Each station is served as an M3U playlist at
`/cliamp-radio/<slug>.m3u`, ready to hand to cliamp or any player that
understands M3U.

A built-in **"All Stations"** playlist (`/cliamp-radio/all.m3u`) is always
available and automatically kept in sync — it's the union of every other
station's tracks with duplicates (matched by stream URL) removed. It's
generated on the fly, shown read-only in the dashboard, and can't be edited,
renamed, or deleted (the name "All" is reserved).

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
(see above), and optionally edit `/etc/systemd/system/cliamp-radio.service`
to uncomment/set `JWT_SECRET` (then `sudo systemctl daemon-reload && sudo
systemctl restart cliamp-radio`).

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
