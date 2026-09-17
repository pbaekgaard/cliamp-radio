import path from "node:path";
import {
  changePassword,
  createSessionToken,
  getMustChangePassword,
  requireAuth,
  SESSION_COOKIE,
  verifyCredentials,
} from "./lib/auth";
import { createDeifSessionToken, DEIF_SESSION_COOKIE, getDeifIdentity, normalizeDeifName } from "./lib/deifIdentity";
import { deifQueueStream, ICY_METAINT as DEIF_ICY_METAINT } from "./lib/deifQueue";
import { activeListens, getAllTimeStats, getLiveStats, recordListen } from "./lib/listeners";
import { checkForUpdate, getCurrentVersion, runUpdate, scheduleServiceRestart } from "./lib/update";
import {
  deleteStation,
  ensureDeifStation,
  getStation,
  isReservedSlug,
  listStations,
  renderM3U,
  saveStation,
  slugify,
  type Station,
} from "./lib/stations";
import { getOrCreatePlaylistStream, getPlaylistStreamStatus, ICY_METAINT, prewarmAllPlaylistStreams, stopAllPlaylistStreams } from "./lib/playlistStream";

const PORT = Number(process.env.PORT || 8000);
const CLIENT_DIST = path.join(import.meta.dir, "..", "client", "dist");

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

function unauthorized() {
  return json({ error: "unauthorized" }, { status: 401 });
}

function clientIp(req: Request, server: Bun.Server): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const addr = server.requestIP(req);
  return addr?.address || "0.0.0.0";
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;

    // --- DEIF FM audio (public) ---
    // Backs the URL that renderM3U() rewrites the DEIF_QUEUE_MARKER track
    // to: the always-on, queue-driven stream (see lib/deifQueue.ts).
    if (pathname === "/cliamp-radio/live/deif-fm.mp3") {
      const wantsMeta = req.headers.get("icy-metadata") === "1";
      const stream = deifQueueStream.subscribe(wantsMeta);
      const headers: Record<string, string> = {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "icy-name": "DEIF FM",
      };
      if (wantsMeta) headers["icy-metaint"] = String(DEIF_ICY_METAINT);
      return new Response(stream, { headers });
    }

    // --- Live playlist-stream audio (public) ---
    // Backs the URLs that renderM3U() rewrites YouTube-playlist tracks to: a
    // single always-on, shuffled-and-looping transcode of the playlist, so
    // every listener hears the same audio at the same position, with ICY
    // "now playing" metadata carrying the current artist/title.
    if (pathname.startsWith("/cliamp-radio/live/")) {
      let playlistId = decodeURIComponent(pathname.replace("/cliamp-radio/live/", "")).replace(/\/+$/, "");
      if (playlistId.endsWith(".mp3")) playlistId = playlistId.slice(0, -4);
      if (!playlistId || playlistId.includes("/") || playlistId === "." || playlistId === "..") {
        return new Response("Not found", { status: 404 });
      }
      const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
      const wantsMeta = req.headers.get("icy-metadata") === "1";
      const stream = getOrCreatePlaylistStream(playlistId, playlistUrl).subscribe(wantsMeta);

      const headers: Record<string, string> = {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "icy-name": "cliamp-radio",
      };
      if (wantsMeta) headers["icy-metaint"] = String(ICY_METAINT);
      return new Response(stream, { headers });
    }

    // --- Playlist-stream status (now playing / listener count) ---
    const nowPlayingMatch = pathname.match(/^\/api\/playlist-stream\/([^/]+)\/status$/);
    if (nowPlayingMatch && req.method === "GET") {
      return json(getPlaylistStreamStatus(decodeURIComponent(nowPlayingMatch[1]!)));
    }

    // --- Batch playlist-stream status (used by the station list UI to show
    // a live listener count per YouTube-playlist "channel" without firing
    // one request per playlist) ---
    if (pathname === "/api/playlist-stream/status" && req.method === "GET") {
      const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const result: Record<string, ReturnType<typeof getPlaylistStreamStatus>> = {};
      for (const id of ids) result[id] = getPlaylistStreamStatus(id);
      return json(result);
    }

    // --- Station M3U streaming (public) ---
    if (pathname.startsWith("/cliamp-radio/")) {
      let slug = decodeURIComponent(pathname.replace("/cliamp-radio/", "")).replace(/\/+$/, "");
      if (slug.endsWith(".m3u")) slug = slug.slice(0, -4);
      if (!slug || slug.includes("/") || slug === "." || slug === "..") {
        return new Response("Station not found", { status: 404 });
      }
      const station = await getStation(slug);
      if (!station) return new Response("Station not found", { status: 404 });

      recordListen(clientIp(req, srv), station.slug, station.name);

      const baseUrl = `${url.protocol}//${url.host}`;
      return new Response(renderM3U(station, baseUrl), {
        headers: { "Content-Type": "audio/x-mpegurl; charset=utf-8" },
      });
    }

    // --- Auth ---
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body?.username || !body?.password) {
        return json({ error: "username and password required" }, { status: 400 });
      }
      const result = await verifyCredentials(body.username, body.password);
      if (!result.ok) return json({ error: "invalid credentials" }, { status: 401 });

      const token = createSessionToken(body.username);
      return json(
        { username: body.username, mustChangePassword: result.mustChangePassword },
        {
          headers: {
            "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`,
          },
        }
      );
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      return json(
        { ok: true },
        { headers: { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` } }
      );
    }

    if (pathname === "/api/auth/me" && req.method === "GET") {
      const user = requireAuth(req);
      if (!user) return unauthorized();
      const mustChangePassword = await getMustChangePassword(user.sub);
      return json({ username: user.sub, mustChangePassword });
    }

    if (pathname === "/api/auth/change-password" && req.method === "POST") {
      const user = requireAuth(req);
      if (!user) return unauthorized();
      const body = await req.json().catch(() => null);
      if (!body?.currentPassword || !body?.newPassword) {
        return json({ error: "currentPassword and newPassword required" }, { status: 400 });
      }
      const result = await changePassword(user.sub, body.currentPassword, body.newPassword);
      if (!result.ok) return json({ error: result.error }, { status: 400 });
      return json({ ok: true });
    }

    // --- DEIF FM identity (name-only "login", no password/account) ---
    if (pathname === "/api/deif/identify" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const name = typeof body?.name === "string" ? normalizeDeifName(body.name) : null;
      if (!name) return json({ error: "a name (1-24 characters) is required" }, { status: 400 });
      const token = createDeifSessionToken(name);
      return json(
        { name },
        {
          headers: {
            "Set-Cookie": `${DEIF_SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`,
          },
        }
      );
    }

    if (pathname === "/api/deif/me" && req.method === "GET") {
      const identity = getDeifIdentity(req);
      if (!identity) return unauthorized();
      return json({ name: identity.name });
    }

    if (pathname === "/api/deif/logout" && req.method === "POST") {
      return json(
        { ok: true },
        { headers: { "Set-Cookie": `${DEIF_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` } }
      );
    }

    // --- DEIF FM queue ---
    if (pathname === "/api/deif/queue" && req.method === "GET") {
      return json(deifQueueStream.list());
    }

    if (pathname === "/api/deif/queue" && req.method === "POST") {
      const identity = getDeifIdentity(req);
      if (!identity) return unauthorized();
      const body = await req.json().catch(() => null);
      if (typeof body?.url !== "string" || !body.url.trim()) {
        return json({ error: "url required" }, { status: 400 });
      }
      try {
        const item = await deifQueueStream.addToQueue(body.url.trim(), identity.name);
        return json(item, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "failed to add to queue" }, { status: 400 });
      }
    }

    const deifQueueItemMatch = pathname.match(/^\/api\/deif\/queue\/(\d+)$/);
    if (deifQueueItemMatch && req.method === "DELETE") {
      const identity = getDeifIdentity(req);
      if (!identity) return unauthorized();
      const result = deifQueueStream.removeFromQueue(Number(deifQueueItemMatch[1]), identity.name);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, { status: 400 });
    }

    if (pathname === "/api/deif/queue/current/skip" && req.method === "POST") {
      const identity = getDeifIdentity(req);
      if (!identity) return unauthorized();
      const result = deifQueueStream.skipCurrent(identity.name);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, { status: 400 });
    }

    // --- Stations CRUD ---
    if (pathname === "/api/stations" && req.method === "GET") {
      return json(await listStations());
    }

    if (pathname === "/api/stations" && req.method === "POST") {
      if (!requireAuth(req)) return unauthorized();
      const body = (await req.json().catch(() => null)) as Partial<Station> | null;
      if (!body?.name || !Array.isArray(body.tracks)) {
        return json({ error: "name and tracks[] required" }, { status: 400 });
      }
      if (isReservedSlug(slugify(body.name))) {
        return json({ error: `"${body.name}" is a reserved station name` }, { status: 400 });
      }
      const saved = await saveStation({ slug: slugify(body.name), name: body.name, tracks: body.tracks });
      prewarmAllPlaylistStreams().catch((err) => console.error("[prewarm] failed after station create:", err));
      return json(saved, { status: 201 });
    }

    const stationMatch = pathname.match(/^\/api\/stations\/([^/]+)$/);
    if (stationMatch) {
      const slug = decodeURIComponent(stationMatch[1]);
      if (req.method === "GET") {
        const station = await getStation(slug);
        return station ? json(station) : json({ error: "not found" }, { status: 404 });
      }
      if (req.method === "PUT") {
        if (!requireAuth(req)) return unauthorized();
        if (isReservedSlug(slug)) {
          return json({ error: "the All Stations playlist is generated automatically and can't be edited" }, { status: 400 });
        }
        const body = (await req.json().catch(() => null)) as Partial<Station> | null;
        if (!body?.name || !Array.isArray(body.tracks)) {
          return json({ error: "name and tracks[] required" }, { status: 400 });
        }
        if (isReservedSlug(slugify(body.name))) {
          return json({ error: `"${body.name}" is a reserved station name` }, { status: 400 });
        }
        if (slugify(body.name) !== slug) await deleteStation(slug);
        const saved = await saveStation({ slug, name: body.name, tracks: body.tracks });
        prewarmAllPlaylistStreams().catch((err) => console.error("[prewarm] failed after station update:", err));
        return json(saved);
      }
      if (req.method === "DELETE") {
        if (!requireAuth(req)) return unauthorized();
        if (isReservedSlug(slug)) {
          return json({ error: "the All Stations playlist is generated automatically and can't be deleted" }, { status: 400 });
        }
        const ok = await deleteStation(slug);
        return ok ? json({ ok: true }) : json({ error: "not found" }, { status: 404 });
      }
    }

    // --- Listeners (for the globe) ---
    if (pathname === "/api/listeners" && req.method === "GET") {
      return json(activeListens());
    }

    // --- Stats (top countries, listening hours, busiest station, etc.) ---
    if (pathname === "/api/stats" && req.method === "GET") {
      return json({ live: getLiveStats(), allTime: getAllTimeStats() });
    }

    // --- Update checker ---
    if (pathname === "/api/update/check" && req.method === "GET") {
      return json(await checkForUpdate());
    }

    if (pathname === "/api/update/install" && req.method === "POST") {
      if (!requireAuth(req)) return unauthorized();
      const result = await runUpdate();
      // Restart (if applicable) only after this response has been handed
      // off, so the client actually sees the result instead of a 502.
      if (result.ok) scheduleServiceRestart();
      return json(result, { status: result.ok ? 200 : 500 });
    }

    if (pathname === "/api/version" && req.method === "GET") {
      return json({ version: getCurrentVersion() });
    }

    // --- Static client (SPA) ---
    const filePath = pathname === "/" ? "/index.html" : pathname;
    const file = Bun.file(path.join(CLIENT_DIST, filePath));
    if (await file.exists()) {
      return new Response(file);
    }
    const indexFile = Bun.file(path.join(CLIENT_DIST, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile, { headers: { "Content-Type": "text/html" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`cliamp-radio server listening on http://0.0.0.0:${PORT}`);

// Pre-warm every YouTube-playlist station immediately so they're already
// playing 24/7 (and buffered) instead of only starting — with a several
// second yt-dlp/ffmpeg startup delay — the moment a first listener connects.
prewarmAllPlaylistStreams().catch((err) => console.error("[prewarm] failed at startup:", err));

// Ensure the "DEIF RADIO" station (with its DEIF FM queue channel) exists,
// and start the queue's playback loop so it's ready the instant the first
// video is queued.
ensureDeifStation()
  .then(() => deifQueueStream.start())
  .catch((err) => console.error("[deif] failed to set up DEIF RADIO station:", err));

function shutdown() {
  stopAllPlaylistStreams();
  deifQueueStream.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
