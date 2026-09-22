import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  changePassword,
  createSessionToken,
  getMustChangePassword,
  requireAuth,
  SESSION_COOKIE,
  verifyCredentials,
} from "./lib/auth";
import { createWorkFmSessionToken, WORKFM_SESSION_COOKIE, getWorkFmIdentity, normalizeWorkFmName } from "./lib/workfmIdentity";
import { deleteLibraryEntry, getLibraryTrack, listHistory, listMostLiked, listSavedUploads, toggleLike } from "./lib/workfmLibrary";
import { ICY_METAINT as WORKFM_ICY_METAINT } from "./lib/workfmQueue";
import { drainText, searchYouTube, searchYouTubeMusic, YTDLP_COOKIE_ARGS, YTDLP_EXTRA_ARGS } from "./lib/youtube";
import { extractSpotifyTrackId, resolveSpotifyTrackQuery } from "./lib/spotify";
import { getWorkFmRoom, startWorkFmRoom, stopWorkFmRoom, WORKFM_ROOM_SLUG } from "./lib/workfmRooms";
import { activeListens, getAllTimeStats, getLiveStats, recordListen } from "./lib/listeners";
import { checkForUpdate, getCurrentVersion, runUpdate, scheduleServiceRestart } from "./lib/update";
import {
  deleteStation,
  getStation,
  isReservedSlug,
  listStations,
  renderM3U,
  saveStation,
  slugify,
  type Station,
} from "./lib/stations";
import {
  deleteAnnouncementFile,
  listAnnouncementFiles,
  saveAnnouncementFile,
  saveAnnouncementFromDisk,
  saveAnnouncementFromYouTube,
  type AnnouncementCategory,
} from "./lib/workfmAnnouncements";
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

/** Strips characters that would break a Content-Disposition filename or
 * cause issues in a downloaded file's name across OSes (quotes, slashes,
 * control chars) — used when serving a History entry's audio for download. */
function sanitizeDownloadFilename(name: string): string {
  const cleaned = name.replace(/["/\\:*?<>|\r\n]/g, "").trim();
  return cleaned || "track";
}

// HTTP header values must be Latin-1/ASCII-ish — room names are freeform
// user input (accents, emoji, etc.), so scrub anything outside printable
// ASCII before using one in the icy-name header (an em dash was enough to
// make Bun throw and 500 the whole request).
function asciiHeaderSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
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

    // --- WorkFM audio (public) ---
    // Backs the URL that renderM3U() rewrites the WORKFM_QUEUE_MARKER track
    // to: WorkFM's single always-on, queue-driven stream (see
    // lib/workfmQueue.ts + lib/workfmRooms.ts).
    const workfmAudioMatch = pathname.match(/^\/cliamp-radio\/live\/workfm\/([^/]+)\.mp3$/);
    if (workfmAudioMatch) {
      const room = getWorkFmRoom(decodeURIComponent(workfmAudioMatch[1]!));
      if (!room) return new Response("Room not found", { status: 404 });
      const wantsMeta = req.headers.get("icy-metadata") === "1";
      const identity = getWorkFmIdentity(req);
      const stream = room.stream.subscribe(wantsMeta, identity?.name);
      const headers: Record<string, string> = {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "icy-name": asciiHeaderSafe(room.name),
      };
      if (wantsMeta) headers["icy-metaint"] = String(WORKFM_ICY_METAINT);
      return new Response(stream, { headers });
    }

    // --- On-demand single-video web-only "tune in" audio (public) ---
    // Not referenced by any station's .m3u (cliamp desktop clients play
    // plain video links directly themselves) — this exists purely so the
    // website's "Tune in" buttons can play *any* track (playlist- or
    // single-video-backed) straight in the browser, by lazily transcoding
    // just that one video the same way playlist channels already are.
    // Namespaced with a "video:" prefix in the shared stream map so it can
    // never collide with a real playlist ID.
    if (pathname.startsWith("/cliamp-radio/live/video/")) {
      let videoId = decodeURIComponent(pathname.replace("/cliamp-radio/live/video/", "")).replace(/\/+$/, "");
      if (videoId.endsWith(".mp3")) videoId = videoId.slice(0, -4);
      if (!videoId || videoId.includes("/") || videoId === "." || videoId === "..") {
        return new Response("Not found", { status: 404 });
      }
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const wantsMeta = req.headers.get("icy-metadata") === "1";
      const stream = getOrCreatePlaylistStream(`video:${videoId}`, videoUrl).subscribe(wantsMeta);

      const headers: Record<string, string> = {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "icy-name": "cliamp-radio",
      };
      if (wantsMeta) headers["icy-metaint"] = String(ICY_METAINT);
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

    // --- WorkFM identity (name-only "login", no password/account) ---
    if (pathname === "/api/workfm/identify" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const name = typeof body?.name === "string" ? normalizeWorkFmName(body.name) : null;
      if (!name) return json({ error: "a name (1-24 characters) is required" }, { status: 400 });
      const token = createWorkFmSessionToken(name);
      return json(
        { name },
        {
          headers: {
            "Set-Cookie": `${WORKFM_SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`,
          },
        }
      );
    }

    if (pathname === "/api/workfm/me" && req.method === "GET") {
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      return json({ name: identity.name });
    }

    if (pathname === "/api/workfm/logout" && req.method === "POST") {
      return json(
        { ok: true },
        { headers: { "Set-Cookie": `${WORKFM_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0` } }
      );
    }

    // --- WorkFM queue ---
    const workfmRoomQueueMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue$/);
    if (workfmRoomQueueMatch && req.method === "GET") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomQueueMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      return json({ ...room.stream.list(identity?.name), roomName: room.name });
    }

    if (workfmRoomQueueMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomQueueMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const body = await req.json().catch(() => null);
      if (typeof body?.url !== "string" || !body.url.trim()) {
        return json({ error: "url required" }, { status: 400 });
      }
      try {
        const item = await room.stream.addToQueue(body.url.trim(), identity.name);
        return json(item, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "failed to add to queue" }, { status: 400 });
      }
    }

    const workfmRoomSearchMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/search$/);
    if (workfmRoomSearchMatch && req.method === "GET") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomSearchMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (!q) return json({ results: [] });
      try {
        // A pasted Spotify track link can't be played directly (DRM), so
        // resolve it to an "artist title" string first and search for that
        // instead — same dropdown-of-results UX either way. For Spotify
        // links specifically we search YouTube *Music*'s "Songs" section
        // rather than plain YouTube video search, since we already know
        // we want the official song audio (not lyric videos, covers,
        // reactions, live performances, etc. that a general search surfaces).
        const spotifyTrackId = extractSpotifyTrackId(q);
        const searchQuery = spotifyTrackId ? await resolveSpotifyTrackQuery(spotifyTrackId) : q;
        if (spotifyTrackId && !searchQuery) {
          return json({ error: "couldn't read that Spotify track — try pasting its name instead" }, { status: 400 });
        }
        const results = spotifyTrackId
          ? await searchYouTubeMusic(searchQuery!, 8)
          : await searchYouTube(searchQuery!, 8);
        return json({ results });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "search failed" }, { status: 500 });
      }
    }

    const workfmRoomUploadMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue\/upload$/);
    if (workfmRoomUploadMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomUploadMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const formData = await req.formData().catch(() => null);
      const file = formData?.get("file");
      if (!(file instanceof File)) return json({ error: "an mp3 file is required" }, { status: 400 });
      const saveForLaterRaw = formData?.get("saveForLater");
      const saveForLater = saveForLaterRaw === null || saveForLaterRaw === undefined || saveForLaterRaw === "true";
      const titleRaw = formData?.get("title");
      const artistRaw = formData?.get("artist");
      const overrides = {
        title: typeof titleRaw === "string" ? titleRaw : undefined,
        artist: typeof artistRaw === "string" ? artistRaw : undefined,
      };
      try {
        const item = await room.stream.addUploadToQueue(file, identity.name, saveForLater, overrides);
        return json(item, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "failed to upload" }, { status: 400 });
      }
    }

    const workfmRoomQueueItemMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue\/(\d+)$/);
    if (workfmRoomQueueItemMatch && req.method === "DELETE") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomQueueItemMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const result = room.stream.removeFromQueue(Number(workfmRoomQueueItemMatch[2]), identity.name);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, { status: 400 });
    }

    const workfmRoomQueueVoteNextMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue\/(\d+)\/next$/);
    if (workfmRoomQueueVoteNextMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomQueueVoteNextMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const result = room.stream.requestMoveToFront(Number(workfmRoomQueueVoteNextMatch[2]), identity.name);
      return result.ok ? json(result) : json({ error: result.error }, { status: 400 });
    }

    const workfmRoomSkipMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue\/current\/skip$/);
    if (workfmRoomSkipMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomSkipMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const result = room.stream.requestSkip(identity.name);
      return result.ok ? json(result) : json({ error: result.error }, { status: 400 });
    }

    const workfmRoomRepeatMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue\/current\/repeat$/);
    if (workfmRoomRepeatMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomRepeatMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const result = room.stream.requestRepeat(identity.name);
      return result.ok ? json(result) : json({ error: result.error }, { status: 400 });
    }

    const workfmRoomChatMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/chat$/);
    if (workfmRoomChatMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomChatMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const body = await req.json().catch(() => null);
      if (typeof body?.text !== "string" || !body.text.trim()) {
        return json({ error: "message can't be empty" }, { status: 400 });
      }
      try {
        const message = room.stream.postChatMessage(identity.name, body.text);
        return json(message, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "failed to send message" }, { status: 400 });
      }
    }

    const workfmRoomRequeueMatch = pathname.match(/^\/api\/workfm\/rooms\/([^/]+)\/queue\/requeue$/);
    if (workfmRoomRequeueMatch && req.method === "POST") {
      const room = getWorkFmRoom(decodeURIComponent(workfmRoomRequeueMatch[1]!));
      if (!room) return json({ error: "room not found" }, { status: 404 });
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const body = await req.json().catch(() => null);
      if (typeof body?.id !== "string" || !body.id.trim()) {
        return json({ error: "a library track id is required" }, { status: 400 });
      }
      const entry = getLibraryTrack(body.id);
      if (!entry) return json({ error: "track not found" }, { status: 404 });
      try {
        const item = room.stream.requeueFromLibrary(entry, identity.name);
        return json(item, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "failed to requeue" }, { status: 400 });
      }
    }

    // --- WorkFM library (history / most-liked / saved uploads — global, across all rooms) ---
    if (pathname === "/api/workfm/library" && req.method === "GET") {
      const identity = getWorkFmIdentity(req);
      const view = url.searchParams.get("view") ?? "history";
      if (view === "most-liked") return json(listMostLiked(identity?.name));
      if (view === "saved") return json(listSavedUploads(identity?.name));
      return json(listHistory(identity?.name));
    }

    const workfmLikeMatch = pathname.match(/^\/api\/workfm\/library\/([^/]+)\/like$/);
    if (workfmLikeMatch && req.method === "POST") {
      const identity = getWorkFmIdentity(req);
      if (!identity) return unauthorized();
      const result = toggleLike(decodeURIComponent(workfmLikeMatch[1]!), identity.name);
      if (!result) return json({ error: "track not found" }, { status: 404 });
      return json(result);
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

    // --- WorkFM announcements/ads (admin-only management of the mp3 files
    // WorkFm's auto-DJ automatically weaves in between tracks — see
    // lib/workfmAnnouncements.ts + workfmQueue.ts's maybeInsertSpecials()) ---
    if (pathname === "/api/admin/workfm/announcements" && req.method === "GET") {
      if (!requireAuth(req)) return unauthorized();
      const [announcements, ads] = await Promise.all([
        listAnnouncementFiles("announcement"),
        listAnnouncementFiles("ad"),
      ]);
      return json({ announcements, ads });
    }

    if (pathname === "/api/admin/workfm/announcements" && req.method === "POST") {
      if (!requireAuth(req)) return unauthorized();
      const formData = await req.formData().catch(() => null);
      const categoryRaw = formData?.get("category");
      const category: AnnouncementCategory | null =
        categoryRaw === "ad" ? "ad" : categoryRaw === "announcement" ? "announcement" : null;
      if (!category) {
        return json({ error: "category ('announcement' or 'ad') is required" }, { status: 400 });
      }
      const titleRaw = formData?.get("title");
      const title = typeof titleRaw === "string" ? titleRaw : undefined;
      const file = formData?.get("file");
      const youtubeUrlRaw = formData?.get("youtubeUrl");
      const youtubeUrl = typeof youtubeUrlRaw === "string" ? youtubeUrlRaw.trim() : "";
      if (!(file instanceof File) && !youtubeUrl) {
        return json({ error: "an mp3 file or a YouTube link is required" }, { status: 400 });
      }
      try {
        const entry =
          file instanceof File
            ? await saveAnnouncementFile(category, file, title)
            : await saveAnnouncementFromYouTube(category, youtubeUrl, title);
        return json(entry, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "failed to add" }, { status: 400 });
      }
    }

    const announcementMatch = pathname.match(/^\/api\/admin\/workfm\/announcements\/([^/]+)$/);
    if (announcementMatch && req.method === "DELETE") {
      if (!requireAuth(req)) return unauthorized();
      const ok = await deleteAnnouncementFile(decodeURIComponent(announcementMatch[1]!));
      return ok ? json({ ok: true }) : json({ error: "not found" }, { status: 404 });
    }

    // Admin test hooks: force an ad break / announcement to play at the
    // very next WorkFM track boundary, instead of waiting for the real
    // interval — lets an admin verify the feature works end-to-end.
    if (pathname === "/api/admin/workfm/force-ad" && req.method === "POST") {
      if (!requireAuth(req)) return unauthorized();
      const room = getWorkFmRoom(WORKFM_ROOM_SLUG);
      if (!room) return json({ error: "room not found" }, { status: 404 });
      room.stream.forceAdBreak();
      return json({ ok: true });
    }

    if (pathname === "/api/admin/workfm/force-announcement" && req.method === "POST") {
      if (!requireAuth(req)) return unauthorized();
      const room = getWorkFmRoom(WORKFM_ROOM_SLUG);
      if (!room) return json({ error: "room not found" }, { status: 404 });
      room.stream.forceAnnouncement();
      return json({ ok: true });
    }

    // Admin: manage the WorkFM library/history (delete a played track's
    // record, e.g. to remove something embarrassing/wrong from history —
    // see workfmLibrary.ts). Listeners' own history/requeue view (GET
    // /api/workfm/library) is unaffected other than the entry disappearing.
    if (pathname === "/api/admin/workfm/history" && req.method === "GET") {
      if (!requireAuth(req)) return unauthorized();
      return json(listHistory(undefined, 1000));
    }

    const historyDeleteMatch = pathname.match(/^\/api\/admin\/workfm\/history\/([^/]+)$/);
    if (historyDeleteMatch && req.method === "DELETE") {
      if (!requireAuth(req)) return unauthorized();
      const ok = await deleteLibraryEntry(decodeURIComponent(historyDeleteMatch[1]!));
      return ok ? json({ ok: true }) : json({ error: "not found" }, { status: 404 });
    }

    // Admin: download a History entry's audio — streams the saved file
    // directly for uploads, or downloads the audio fresh via yt-dlp (to a
    // throwaway temp file, cleaned up immediately after) for YouTube tracks
    // that were never saved to disk locally.
    const historyDownloadMatch = pathname.match(/^\/api\/admin\/workfm\/history\/([^/]+)\/download$/);
    if (historyDownloadMatch && req.method === "GET") {
      if (!requireAuth(req)) return unauthorized();
      const entry = getLibraryTrack(decodeURIComponent(historyDownloadMatch[1]!));
      if (!entry) return json({ error: "not found" }, { status: 404 });
      const downloadName = `${sanitizeDownloadFilename(`${entry.artist} - ${entry.title}`)}.mp3`;

      if (entry.source === "upload") {
        if (!entry.savedFilePath || !(await Bun.file(entry.savedFilePath).exists())) {
          return json({ error: "that file is no longer saved on disk" }, { status: 404 });
        }
        return new Response(Bun.file(entry.savedFilePath), {
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Disposition": `attachment; filename="${downloadName}"`,
          },
        });
      }

      const videoUrl = entry.url || (entry.videoId ? `https://www.youtube.com/watch?v=${entry.videoId}` : null);
      if (!videoUrl) return json({ error: "no video URL on record for this track" }, { status: 400 });
      const tmpDir = path.join(import.meta.dir, "data", "workfm-history-downloads");
      await mkdir(tmpDir, { recursive: true });
      const tmpId = crypto.randomUUID();
      const tmpPath = path.join(tmpDir, `${tmpId}.mp3`);
      const proc = Bun.spawn(
        [
          "yt-dlp",
          ...YTDLP_COOKIE_ARGS,
          ...YTDLP_EXTRA_ARGS,
          "-x",
          "--audio-format",
          "mp3",
          "--no-playlist",
          "--quiet",
          "--no-warnings",
          "-o",
          path.join(tmpDir, `${tmpId}.%(ext)s`),
          videoUrl,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const stderr = await drainText(proc.stderr);
      const exitCode = await proc.exited;
      if (exitCode !== 0 || !(await Bun.file(tmpPath).exists())) {
        return json({ error: `failed to download audio${stderr.trim() ? `: ${stderr.trim()}` : ""}` }, { status: 502 });
      }
      const bytes = await Bun.file(tmpPath).arrayBuffer();
      await rm(tmpPath, { force: true });
      return new Response(bytes, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": `attachment; filename="${downloadName}"`,
        },
      });
    }

    // Admin: promote a History entry into the announcements/ads pool —
    // copies its audio (or, for YouTube, downloads it fresh via yt-dlp)
    // into workfm-announcements/, then removes the History entry so it can
    // no longer be requeued/auto-DJ'd as a regular song; from then on it
    // only plays as a scheduled ad/announcement (see workfmQueue.ts).
    const historyPromoteMatch = pathname.match(/^\/api\/admin\/workfm\/history\/([^/]+)\/promote$/);
    if (historyPromoteMatch && req.method === "POST") {
      if (!requireAuth(req)) return unauthorized();
      const id = decodeURIComponent(historyPromoteMatch[1]!);
      const entry = getLibraryTrack(id);
      if (!entry) return json({ error: "not found" }, { status: 404 });
      const body = await req.json().catch(() => null);
      const category: AnnouncementCategory | null =
        body?.category === "ad" ? "ad" : body?.category === "announcement" ? "announcement" : null;
      if (!category) return json({ error: "category ('announcement' or 'ad') is required" }, { status: 400 });
      const label = `${entry.artist} - ${entry.title}`;
      try {
        const promoted =
          entry.source === "upload"
            ? entry.savedFilePath
              ? await saveAnnouncementFromDisk(category, entry.savedFilePath, label)
              : null
            : await saveAnnouncementFromYouTube(
                category,
                entry.url || `https://www.youtube.com/watch?v=${entry.videoId}`,
                label
              );
        if (!promoted) return json({ error: "that upload's file is no longer saved on disk" }, { status: 400 });
        await deleteLibraryEntry(id);
        return json(promoted, { status: 201 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : `failed to mark as ${category}` }, { status: 400 });
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
      return json(await checkForUpdate(url.searchParams.get("force") === "1"));
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

// Note: WorkFM is a single persistent room (see lib/workfmRooms.ts) that
// starts its playback loop here, alongside the playlist stations.
startWorkFmRoom();

function shutdown() {
  stopAllPlaylistStreams();
  stopWorkFmRoom();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
