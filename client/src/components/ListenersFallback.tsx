import type { Listener } from "../api";

export default function ListenersFallback({ listeners }: { listeners: Listener[] }) {
  return (
    <div className="listeners-fallback">
      <h1>Cliamp Radio</h1>
      <p className="muted">
        Live map unavailable right now — showing current listeners as a list instead.
      </p>
      <div className="globe-count" style={{ position: "static", display: "inline-block", marginBottom: 16 }}>
        {listeners.length} listener{listeners.length === 1 ? "" : "s"} tuned in right now
      </div>
      <ul className="listener-list">
        {listeners.map((l, i) => (
          <li key={i}>
            <b>{l.stationName}</b> — {l.city}, {l.country}
          </li>
        ))}
        {listeners.length === 0 && <li className="muted">No one's listening right now.</li>}
      </ul>
    </div>
  );
}
