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

## Configuration (environment variables)

| Variable              | Purpose                                                   | Default          |
| --------------------- | ---------------------------------------------------------- | ----------------- |
| `PORT`                | HTTP port                                                  | `8000`            |
| `ADMIN_USERNAME`      | Dashboard login username                                   | `admin`           |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the admin password                          | hash of `changeme`|
| `JWT_SECRET`          | Secret used to sign session cookies                        | dev default — **change this** |
| `APP_VERSION`         | Version this deployment reports as "current"               | `0.0.0`           |
| `GITHUB_REPO`         | `owner/repo` to check for releases                         | `pbaekgaard/cliamp-radio` |

Generate a password hash:

```bash
cd server && bun -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

**Change `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, and `JWT_SECRET` before
exposing this to the internet** — the defaults are for local development only.

## Adding stations

Log in at `/login`, then use the dashboard at `/dashboard` to add/edit/delete
stations and their tracks. Each station is served as an M3U playlist at
`/cliamp-radio/<slug>.m3u`, ready to hand to cliamp or any player that
understands M3U.

## Deploying with systemd + auto-update

1. Clone this repo on your server and set the env vars above (either via a
   systemd `Environment=` line or an `EnvironmentFile=`).
2. Copy `systemd/cliamp-radio.service` to `/etc/systemd/system/`, adjusting
   the `User=`/paths, then `systemctl enable --now cliamp-radio`.
3. Allow the service user to restart itself without a password so the
   in-app "Install update" button works:
   ```
   youruser ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart cliamp-radio
   ```
4. Tag and push a release (`git tag v1.0.1 && git push --tags`) — GitHub
   Actions publishes a Release, and every running instance will pick it up
   on its next poll and show the update prompt.

## Releasing a new version

Push a tag matching `v*.*.*` and the `Release` workflow
(`.github/workflows/release.yml`) auto-generates a GitHub Release with notes
from the commits since the last tag.
