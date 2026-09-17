import { useEffect, useState } from "react";
import { api, type PlaylistStreamStatus, type Station } from "../api";
import { useRadioPlayer } from "../RadioPlayerContext";
import { extractYouTubePlaylistId, tuneInUrlForTrack } from "../youtube";

// Matches server/lib/stations.ts's HEADER_PLACEHOLDER_URL — the inert
// divider entries injected between each station's tracks in the
// auto-generated "All Stations" playlist. Filtered out of the track
// dropdown below since they aren't real songs.
const HEADER_PLACEHOLDER_URL = "https://cliamp-radio.invalid/divider";

function buildConfig(station: Station): string {
  const host = window.location.hostname;
  const origin = window.location.origin;
  return `[[station]]\nname = "${host} — ${station.name}"\nurl = "${origin}/cliamp-radio/${station.slug}.m3u"\n`;
}

function buildAllConfigs(stations: Station[]): string {
  return stations.map(buildConfig).join("\n");
}

function legacyCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // best-effort — nothing more we can do if this fails too
  }
  document.body.removeChild(ta);
}

export default function StationList() {
  const [stations, setStations] = useState<Station[]>([]);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [playlistStatuses, setPlaylistStatuses] = useState<Record<string, PlaylistStreamStatus>>({});
  const { nowPlaying, toggle } = useRadioPlayer();

  useEffect(() => {
    api.listStations().then(setStations).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const listeners = await api.listeners();
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const l of listeners) next[l.station] = (next[l.station] || 0) + 1;
        setCounts(next);
      } catch {
        // ignore transient network errors
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const playlistIds = Array.from(
    new Set(
      stations.flatMap((s) => s.tracks.map((t) => extractYouTubePlaylistId(t.path)).filter((id): id is string => !!id))
    )
  ).sort();
  const playlistIdsKey = playlistIds.join(",");

  useEffect(() => {
    if (playlistIds.length === 0) {
      setPlaylistStatuses({});
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const statuses = await api.playlistStreamStatuses(playlistIds);
        if (!cancelled) setPlaylistStatuses(statuses);
      } catch {
        // ignore transient network errors
      }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // Intentionally keyed on playlistIdsKey (a stable string) rather than
    // the `playlistIds` array itself, which is a new reference every render.
  }, [playlistIdsKey]);

  async function copyText(text: string) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else legacyCopy(text);
    } catch {
      legacyCopy(text);
    }
  }

  async function copy(station: Station) {
    await copyText(buildConfig(station));
    setCopiedSlug(station.slug);
    setTimeout(() => setCopiedSlug((s) => (s === station.slug ? null : s)), 1600);
  }

  async function copyAll() {
    await copyText(buildAllConfigs(stations));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1600);
  }

  function toggleExpand(slug: string) {
    setExpandedSlug((s) => (s === slug ? null : slug));
  }

  if (!stations.length) return null;

  return (
    <div className="station-config-list">
      <div className="station-config-header">
        <div>
          <h2>Radio Stations</h2>
          <p className="muted">
            Add a station straight into your cliamp <code>radios.toml</code> — copy one, or grab them all at once.
          </p>
        </div>
        <button className="btn-secondary" onClick={copyAll}>
          {copiedAll ? "Copied ✓" : `Copy all stations (${stations.length})`}
        </button>
      </div>
      <div className="station-config-items">
        {stations.map((s) => {
          const tracks = s.tracks.filter((t) => t.path !== HEADER_PLACEHOLDER_URL);
          // Stations built (wholly or partly) from YouTube playlists get an
          // accurate, real-time listener count by summing the live subscriber
          // counts of their own playlist "channels" (below) rather than the
          // heuristic IP/M3U-request-based count, which only reflects
          // whoever fetched the .m3u and goes stale for hours after they
          // actually stop listening. Stations with no playlist tracks (rare
          // — just direct video/audio links) have no such signal available
          // and fall back to that heuristic count.
          const stationPlaylistIds = new Set(
            tracks.map((t) => extractYouTubePlaylistId(t.path)).filter((id): id is string => !!id)
          );
          const n =
            stationPlaylistIds.size > 0
              ? [...stationPlaylistIds].reduce((sum, id) => sum + (playlistStatuses[id]?.listeners ?? 0), 0)
              : counts[s.slug] || 0;
          const expanded = expandedSlug === s.slug;
          return (
            <div className="station-config-wrap" key={s.slug}>
              <div
                className="station-config-item station-config-clickable"
                role="button"
                tabIndex={0}
                onClick={() => toggleExpand(s.slug)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleExpand(s.slug);
                  }
                }}
                aria-expanded={expanded}
                aria-label={expanded ? "Hide tracks" : "Show tracks"}
              >
                <div className="station-config-info">
                  <div className="station-config-name">
                    {s.name}
                    {s.virtual && <span className="badge">auto-generated</span>}
                    <span className={`station-listener-count${n > 0 ? " live" : ""}`}>
                      <span className={`live-dot${n > 0 ? "" : " idle"}`} />
                      {n} listening
                    </span>
                  </div>
                  <code className="station-config-url">/cliamp-radio/{s.slug}.m3u</code>
                </div>
                <button
                  className="btn-secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    copy(s);
                  }}
                >
                  {copiedSlug === s.slug ? "Copied ✓" : "Copy config"}
                </button>
                <span className="station-expand-toggle" aria-hidden="true">
                  <span className={`station-expand-chevron${expanded ? " open" : ""}`}>▸</span>
                </span>
              </div>
              {expanded && (
                <div className="station-track-panel">
                  <p className="station-track-header">Channels:</p>
                  <ul className="station-track-list">
                    {tracks.map((t, i) => {
                      const playlistId = extractYouTubePlaylistId(t.path);
                      const status = playlistId ? playlistStatuses[playlistId] : undefined;
                      const listening = status?.listeners ?? 0;
                      const trackTuneInUrl = tuneInUrlForTrack(t.path);
                      const trackIsPlaying = trackTuneInUrl !== null && nowPlaying?.url === trackTuneInUrl;
                      return (
                        <li key={i} className="station-track-row">
                          <span className="station-track-title">{t.title}</span>
                          <span className="station-track-actions">
                            {playlistId && (
                              <span className={`station-listener-count track-listener-count${listening > 0 ? " live" : ""}`}>
                                <span className={`live-dot${listening > 0 ? "" : " idle"}`} />
                                {listening} listening
                              </span>
                            )}
                            {trackTuneInUrl && (
                              <button
                                className="btn-secondary track-tune-in-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggle(trackTuneInUrl, `${s.name} — ${t.title}`);
                                }}
                                aria-label={trackIsPlaying ? "Pause" : "Tune in"}
                              >
                                {trackIsPlaying ? "⏸" : "▶"}
                              </button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                    {tracks.length === 0 && <li className="muted">No tracks yet.</li>}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
