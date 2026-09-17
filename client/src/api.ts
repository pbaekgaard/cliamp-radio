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

export interface DeifQueueItem {
  id: number;
  videoId: string;
  url: string;
  artist: string;
  title: string;
  addedBy: string;
  addedAt: number;
  source: "youtube" | "upload";
}

export interface DeifSkipVoteState {
  votes: number;
  total: number;
  hasVoted: boolean;
}

export interface DeifQueueState {
  nowPlaying: DeifQueueItem | null;
  queue: DeifQueueItem[];
  listeners: string[];
  /** Audio-stream connections with no name attached — cliamp (the desktop
   * player) and anyone browsing /deif who hit "Listen live" without joining. */
  anonymousListeners: number;
  skipVote: DeifSkipVoteState;
}

export interface DeifSkipResult {
  ok: true;
  skipped?: boolean;
  votes?: number;
  total?: number;
  hasVoted?: boolean;
}

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

  // --- DEIF FM ---
  deifIdentify: (name: string) => request<{ name: string }>("/api/deif/identify", { method: "POST", body: JSON.stringify({ name }) }),
  deifMe: () => request<{ name: string }>("/api/deif/me"),
  deifLogout: () => request("/api/deif/logout", { method: "POST" }),
  deifQueue: () => request<DeifQueueState>("/api/deif/queue"),
  deifAddToQueue: (url: string) =>
    request<DeifQueueItem>("/api/deif/queue", { method: "POST", body: JSON.stringify({ url }) }),
  deifUploadToQueue: async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/deif/queue/upload", { method: "POST", credentials: "include", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<DeifQueueItem>;
  },
  deifRemoveFromQueue: (id: number) => request(`/api/deif/queue/${id}`, { method: "DELETE" }),
  deifSkipCurrent: () => request<DeifSkipResult>("/api/deif/queue/current/skip", { method: "POST" }),
};
