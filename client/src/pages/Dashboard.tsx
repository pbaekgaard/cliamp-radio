import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Station, type Track } from "../api";
import { useAuth } from "../AuthContext";

const emptyDraft = (): { name: string; tracks: Track[] } => ({ name: "", tracks: [{ title: "", path: "" }] });

export default function Dashboard() {
  const { username, logout } = useAuth();
  const [stations, setStations] = useState<Station[]>([]);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setStations(await api.listStations());
  }

  useEffect(() => {
    refresh();
  }, []);

  function startNew() {
    setEditingSlug("__new__");
    setDraft(emptyDraft());
    setError(null);
  }

  function startEdit(station: Station) {
    setEditingSlug(station.slug);
    setDraft({ name: station.name, tracks: station.tracks.map((t) => ({ ...t })) });
    setError(null);
  }

  function cancelEdit() {
    setEditingSlug(null);
    setError(null);
  }

  function updateTrack(i: number, field: keyof Track, value: string) {
    setDraft((d) => ({ ...d, tracks: d.tracks.map((t, idx) => (idx === i ? { ...t, [field]: value } : t)) }));
  }

  function addTrack() {
    setDraft((d) => ({ ...d, tracks: [...d.tracks, { title: "", path: "" }] }));
  }

  function removeTrack(i: number) {
    setDraft((d) => ({ ...d, tracks: d.tracks.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    setError(null);
    const cleanTracks = draft.tracks.filter((t) => t.title.trim() && t.path.trim());
    if (!draft.name.trim() || cleanTracks.length === 0) {
      setError("Station needs a name and at least one track.");
      return;
    }
    try {
      const payload = { name: draft.name.trim(), tracks: cleanTracks };
      if (editingSlug && editingSlug !== "__new__") {
        await api.updateStation(editingSlug, payload);
      } else {
        await api.createStation(payload);
      }
      setEditingSlug(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(slug: string) {
    if (!confirm("Delete this station?")) return;
    await api.deleteStation(slug);
    await refresh();
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Stations</h1>
        <div className="header-actions">
          <span className="muted">Signed in as {username}</span>
          <Link className="btn-secondary" to="/">
            View globe
          </Link>
          <button className="btn-secondary" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </header>

      <button className="btn-primary" onClick={startNew}>
        + New station
      </button>

      <div className="station-list">
        {stations.map((s) => (
          <div className="station-card" key={s.slug}>
            <div className="station-card-head">
              <div>
                <h3>{s.name}</h3>
                <span className="muted">/cliamp-radio/{s.slug}.m3u · {s.tracks.length} track(s)</span>
              </div>
              <div className="header-actions">
                <button className="btn-secondary" onClick={() => startEdit(s)}>
                  Edit
                </button>
                <button className="btn-danger" onClick={() => remove(s.slug)}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editingSlug && (
        <div className="modal-backdrop" onClick={cancelEdit}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingSlug === "__new__" ? "New station" : `Edit ${draft.name}`}</h2>
            <label>
              Station name
              <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </label>
            <h4>Tracks</h4>
            {draft.tracks.map((t, i) => (
              <div className="track-row" key={i}>
                <input
                  placeholder="Title"
                  value={t.title}
                  onChange={(e) => updateTrack(i, "title", e.target.value)}
                />
                <input
                  placeholder="Stream URL"
                  value={t.path}
                  onChange={(e) => updateTrack(i, "path", e.target.value)}
                />
                <button className="btn-danger" onClick={() => removeTrack(i)}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn-secondary" onClick={addTrack}>
              + Add track
            </button>
            {error && <div className="error">{error}</div>}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={cancelEdit}>
                Cancel
              </button>
              <button className="btn-primary" onClick={save}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
