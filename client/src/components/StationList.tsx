import { useEffect, useState } from "react";
import { api, type Station } from "../api";

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
          const n = counts[s.slug] || 0;
          return (
            <div className="station-config-item" key={s.slug}>
              <div>
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
              <button className="btn-secondary" onClick={() => copy(s)}>
                {copiedSlug === s.slug ? "Copied ✓" : "Copy config"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
