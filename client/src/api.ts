export interface Track {
  title: string;
  path: string;
}

export interface Station {
  slug: string;
  name: string;
  tracks: Track[];
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
    request<{ username: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  me: () => request<{ username: string }>("/api/auth/me"),

  listStations: () => request<Station[]>("/api/stations"),
  createStation: (station: Omit<Station, "slug">) =>
    request<Station>("/api/stations", { method: "POST", body: JSON.stringify(station) }),
  updateStation: (slug: string, station: Omit<Station, "slug">) =>
    request<Station>(`/api/stations/${slug}`, { method: "PUT", body: JSON.stringify(station) }),
  deleteStation: (slug: string) => request(`/api/stations/${slug}`, { method: "DELETE" }),

  listeners: () => request<Listener[]>("/api/listeners"),

  updateCheck: () => request<UpdateStatus>("/api/update/check"),
  updateInstall: () => request<{ ok: boolean; log: string }>("/api/update/install", { method: "POST" }),
};
