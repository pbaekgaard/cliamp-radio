import { useEffect, useState } from "react";
import { api, type StatsResponse } from "../api";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${fmt(h)}h`;
}

function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

function useStats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await api.stats();
        if (!cancelled) setStats(data);
      } catch {
        // ignore transient network errors
      }
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return stats;
}

export function useLiveListenerCount() {
  const stats = useStats();
  return stats?.live.listeners ?? null;
}

export default function StatsPanel() {
  const stats = useStats();
  if (!stats) return null;

  const live = stats.live.listeners > 0;
  const countries = live ? stats.live.topCountries : stats.allTime.topCountries;
  const busiest = live ? stats.live.busiestStation : stats.allTime.busiestStation;
  const busiestLabel = live ? "busiest station now" : "busiest station · all-time";
  const max = countries[0]?.count || 1;

  return (
    <div className="stats-side">
      <div className="stats-side-h">
        <span>{live ? "TOP COUNTRIES" : "TOP COUNTRIES · ALL-TIME"}</span>
        <span>{live ? "LISTENERS" : "SESSIONS"}</span>
      </div>
      <div className="stats-rows">
        {countries.length === 0 ? (
          <div className="stats-row-empty">nobody's tuned in yet</div>
        ) : (
          countries.map((c) => (
            <div className="stats-row" key={c.code}>
              <div>
                <div className="stats-row-nm">
                  <span>{c.name}</span>
                </div>
                <div className="stats-bar">
                  <i style={{ width: `${Math.max(2, Math.round((c.count / max) * 100))}%` }} />
                </div>
              </div>
              <span className="stats-row-v">{fmt(c.count)}</span>
            </div>
          ))
        )}
      </div>

      <div className="stats-tiles">
        <div className="stats-tile">
          <div className="v">{busiest ? busiest.name : "–"}</div>
          <div className="l">{busiestLabel}</div>
        </div>
        <div className="stats-tile">
          <div className="v">{fmt(stats.allTime.peakListeners)}</div>
          <div className="l">peak listeners</div>
        </div>
        <div className="stats-tile">
          <div className="v">{fmt(stats.allTime.totalSessions)}</div>
          <div className="l">total sessions</div>
        </div>
        <div className="stats-tile">
          <div className="v">{fmtHours(stats.allTime.totalListenHours)}</div>
          <div className="l">hours streamed</div>
        </div>
      </div>

      {stats.allTime.daily.length > 0 && (
        <div className="stats-daily">
          <div className="stats-side-h">
            <span>LISTENING HOURS · LAST 31 DAYS</span>
          </div>
          <div className="stats-daily-bars">
            {(() => {
              const max = Math.max(...stats.allTime.daily.map((d) => d.hours), 0.001);
              return stats.allTime.daily.map((d) => (
                <i
                  key={d.date}
                  style={{ height: `${Math.max(4, Math.round((d.hours / max) * 100))}%` }}
                  title={`${fmtDate(d.date)} · ${d.hours.toFixed(1)}h`}
                />
              ));
            })()}
          </div>
          <div className="stats-daily-labels">
            <span>{fmtDate(stats.allTime.daily[0].date)}</span>
            <span>{fmtDate(stats.allTime.daily[stats.allTime.daily.length - 1].date)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
