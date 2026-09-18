export interface Track {
  title: string;
  path: string;
}

export interface Station {
  slug: string;
  name: string;
  tracks: Track[];
  virtual?: boolean;
}

export interface Listener {
  station: string;
  stationName: string;
  lat: number;
  lng: number;
  city: string;
  country: string;
  timestamp: number;
}

export interface ReleaseInfo {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
}

export interface UpdateStatus {
  current: string;
  updateAvailable: boolean;
  latest: ReleaseInfo | null;
  /** True if the live GitHub check failed (rate limit, network) and this
   * result is a fallback (cached/stale or "unknown") rather than a fresh
   * look at what's actually on GitHub right now. */
  checkFailed?: boolean;
}

export interface CountryCount {
  code: string;
  name: string;
  count: number;
}

export interface StationCount {
  slug: string;
  name: string;
  count: number;
}

export interface LiveStats {
  listeners: number;
  countries: number;
  topCountries: CountryCount[];
  busiestStation: StationCount | null;
}

export interface AllTimeStats {
  totalSessions: number;
  totalListenHours: number;
  peakListeners: number;
  topCountries: CountryCount[];
  busiestStation: StationCount | null;
  daily: Array<{ date: string; hours: number }>;
}

export interface StatsResponse {
  live: LiveStats;
  allTime: AllTimeStats;
}

export interface PlaylistStreamStatus {
  running: boolean;
  listeners: number;
  nowPlaying: { artist: string; title: string } | null;
}

export interface WorkFmQueueItem {
  id: number;
  videoId: string;
  url: string;
  artist: string;
  title: string;
  addedBy: string;
  addedAt: number;
  source: "youtube" | "upload";
  libraryId: string;
  /** Global (cross-room) like count/state from the library — see
   * workfmLibrary.ts. Zero/false until the track's actually been played
   * at least once anywhere. */
  likes: number;
  likedByMe: boolean;
}

export interface WorkFmChatMessage {
  id: number;
  name: string;
  text: string;
  at: number;
}

export interface WorkFmSkipVoteState {
  votes: number;
  total: number;
  hasVoted: boolean;
}

export interface WorkFmRepeatVoteState {
  armed: boolean;
  votes: number;
  total: number;
  hasVoted: boolean;
}

export interface WorkFmMember {
  name: string;
  /** Whether this person is currently connected to the audio stream, as
   * opposed to just having the room page open. */
  listening: boolean;
}

export interface WorkFmLeaderboardEntry {
  libraryId: string;
  title: string;
  artist: string;
  likes: number;
  likedByMe: boolean;
  addedBy: string;
  available: boolean;
}

export interface WorkFmQueueState {
  roomName: string;
  nowPlaying: WorkFmQueueItem | null;
  queue: WorkFmQueueItem[];
  listeners: string[];
  /** Audio-stream connections with no name attached — cliamp (the desktop
   * player) and anyone browsing /workfm who hit "Listen live" without joining. */
  anonymousListeners: number;
  /** Everyone currently present in the room (page open), each flagged with
   * whether they're also tuned into the audio stream right now. */
  members: WorkFmMember[];
  /** Top 5 most-liked songs across every WorkFM room (global, not scoped to
   * this one) — only tracks with at least one like show up. */
  leaderboard: WorkFmLeaderboardEntry[];
  skipVote: WorkFmSkipVoteState;
  repeatVote: WorkFmRepeatVoteState;
  chat: WorkFmChatMessage[];
}

export interface WorkFmSkipResult {
  ok: true;
  skipped?: boolean;
  votes?: number;
  total?: number;
  hasVoted?: boolean;
}

export interface WorkFmRepeatResult {
  ok: true;
  armed?: boolean;
  votes?: number;
  total?: number;
  hasVoted?: boolean;
}

export interface WorkFmLibraryTrack {
  id: string;
  source: "youtube" | "upload";
  artist: string;
  title: string;
  addedBy: string;
  firstPlayedAt: number;
  lastPlayedAt: number;
  playCount: number;
  likes: number;
  likedByMe: boolean;
  available: boolean;
  savedUntil?: number;
}

export type WorkFmLibraryView = "history" | "most-liked" | "saved";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  login: (username: string, password: string) =>
    request<{ username: string; mustChangePassword: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  me: () => request<{ username: string; mustChangePassword: boolean }>("/api/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  listStations: () => request<Station[]>("/api/stations"),
  createStation: (station: Omit<Station, "slug">) =>
    request<Station>("/api/stations", { method: "POST", body: JSON.stringify(station) }),
  updateStation: (slug: string, station: Omit<Station, "slug">) =>
    request<Station>(`/api/stations/${slug}`, { method: "PUT", body: JSON.stringify(station) }),
  deleteStation: (slug: string) => request(`/api/stations/${slug}`, { method: "DELETE" }),

  listeners: () => request<Listener[]>("/api/listeners"),
  stats: () => request<StatsResponse>("/api/stats"),
  playlistStreamStatuses: (playlistIds: string[]) =>
    playlistIds.length === 0
      ? Promise.resolve({} as Record<string, PlaylistStreamStatus>)
      : request<Record<string, PlaylistStreamStatus>>(
          `/api/playlist-stream/status?ids=${playlistIds.map(encodeURIComponent).join(",")}`
        ),

  updateCheck: (force = false) => request<UpdateStatus>(`/api/update/check${force ? "?force=1" : ""}`),
  version: () => request<{ version: string }>("/api/version"),
  // Deliberately doesn't use request(): we want the log/output even when the
  // update script fails (non-2xx), instead of throwing it away.
  updateInstall: async (): Promise<{ ok: boolean; log: string }> => {
    const res = await fetch("/api/update/install", { method: "POST", credentials: "include" });
    try {
      return await res.json();
    } catch {
      return { ok: false, log: `Server returned ${res.status} ${res.statusText} with no readable output.` };
    }
  },

  // --- WorkFM ---
  workfmIdentify: (name: string) => request<{ name: string }>("/api/workfm/identify", { method: "POST", body: JSON.stringify({ name }) }),
  workfmMe: () => request<{ name: string }>("/api/workfm/me"),
  workfmLogout: () => request("/api/workfm/logout", { method: "POST" }),
  workfmQueue: (slug: string) => request<WorkFmQueueState>(`/api/workfm/rooms/${slug}/queue`),
  workfmAddToQueue: (slug: string, url: string) =>
    request<WorkFmQueueItem>(`/api/workfm/rooms/${slug}/queue`, { method: "POST", body: JSON.stringify({ url }) }),
  workfmUploadToQueue: async (
    slug: string,
    file: File,
    saveForLater = true,
    overrides?: { title?: string; artist?: string },
  ) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("saveForLater", String(saveForLater));
    if (overrides?.title?.trim()) formData.append("title", overrides.title.trim());
    if (overrides?.artist?.trim()) formData.append("artist", overrides.artist.trim());
    const res = await fetch(`/api/workfm/rooms/${slug}/queue/upload`, { method: "POST", credentials: "include", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<WorkFmQueueItem>;
  },
  workfmRemoveFromQueue: (slug: string, id: number) => request(`/api/workfm/rooms/${slug}/queue/${id}`, { method: "DELETE" }),
  workfmSkipCurrent: (slug: string) => request<WorkFmSkipResult>(`/api/workfm/rooms/${slug}/queue/current/skip`, { method: "POST" }),
  workfmRepeatCurrent: (slug: string) => request<WorkFmRepeatResult>(`/api/workfm/rooms/${slug}/queue/current/repeat`, { method: "POST" }),
  workfmPostChat: (slug: string, text: string) =>
    request<WorkFmChatMessage>(`/api/workfm/rooms/${slug}/chat`, { method: "POST", body: JSON.stringify({ text }) }),
  workfmRequeue: (slug: string, id: string) =>
    request<WorkFmQueueItem>(`/api/workfm/rooms/${slug}/queue/requeue`, { method: "POST", body: JSON.stringify({ id }) }),
  workfmLibrary: (view: WorkFmLibraryView = "history") => request<WorkFmLibraryTrack[]>(`/api/workfm/library?view=${view}`),
  workfmToggleLike: (id: string) =>
    request<{ likes: number; liked: boolean }>(`/api/workfm/library/${encodeURIComponent(id)}/like`, { method: "POST" }),
};
