import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Station, type Track, type WorkFmAnnouncementFile } from "../api";
import { useAuth } from "../AuthContext";
import { useUpdate } from "../UpdateContext";

const emptyDraft = (): { name: string; tracks: Track[] } => ({ name: "", tracks: [{ title: "", path: "" }] });

export default function Dashboard() {
  const { username, logout } = useAuth();
  const { checking, checkNow, requestOpen } = useUpdate();
  const [stations, setStations] = useState<Station[]>([]);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [error, setError] = useState<string | null>(null);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [announcements, setAnnouncements] = useState<WorkFmAnnouncementFile[]>([]);
  const [ads, setAds] = useState<WorkFmAnnouncementFile[]>([]);
  const [announcementError, setAnnouncementError] = useState<string | null>(null);
  const [uploadingAnnouncement, setUploadingAnnouncement] = useState(false);
  const [uploadingAd, setUploadingAd] = useState(false);
  const announcementFileInput = useRef<HTMLInputElement>(null);
  const adFileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setStations(await api.listStations());
  }

  async function refreshAnnouncements() {
    const { announcements, ads } = await api.adminListAnnouncements();
    setAnnouncements(announcements);
    setAds(ads);
  }

  async function uploadAnnouncementFile(category: "announcement" | "ad", input: HTMLInputElement | null) {
    const file = input?.files?.[0];
    if (!file) return;
    setAnnouncementError(null);
    const setUploading = category === "ad" ? setUploadingAd : setUploadingAnnouncement;
    setUploading(true);
    try {
      await api.adminUploadAnnouncement(category, file);
      if (input) input.value = "";
      await refreshAnnouncements();
    } catch (err) {
      setAnnouncementError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function removeAnnouncementFile(id: string) {
    if (!confirm("Delete this file?")) return;
    setAnnouncementError(null);
    try {
      await api.adminDeleteAnnouncement(id);
      await refreshAnnouncements();
    } catch (err) {
      setAnnouncementError(err instanceof Error ? err.message : String(err));
    }
  }

  async function checkUpdatesNow() {
    setUpdateMessage(null);
    const res = await checkNow(true);
    if (!res) {
      setUpdateMessage("Couldn't reach GitHub to check for updates.");
    } else if (res.updateAvailable) {
      requestOpen();
    } else if (res.checkFailed) {
      setUpdateMessage(
        "Couldn't reach GitHub right now (rate-limited or unreachable) — showing the last known result, which may be stale. Try again shortly."
      );
    } else {
      setUpdateMessage(`You're up to date (${res.current}).`);
    }
  }

  useEffect(() => {
    refresh();
    refreshAnnouncements();
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
        <div>
          <h1>Manage Stations</h1>
          <p className="muted dashboard-subtitle">Cliamp Radio admin</p>
        </div>
        <div className="header-actions">
          <span className="muted">Signed in as {username}</span>
          <button className="btn-secondary" onClick={checkUpdatesNow} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
          <Link className="btn-secondary" to="/">
            View public page
          </Link>
          <button className="btn-secondary" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </header>

      {updateMessage && <p className="muted update-check-message">{updateMessage}</p>}

      <button className="btn-primary" onClick={startNew}>
        + New station
      </button>

      <div className="station-list">
        {stations.map((s) => (
          <div className="station-card" key={s.slug}>
            <div className="station-card-head">
              <div>
                <h3>
                  {s.name}
                  {s.virtual && <span className="badge">auto-generated</span>}
                </h3>
                <span className="muted">/cliamp-radio/{s.slug}.m3u · {s.tracks.length} track(s)</span>
              </div>
              <div className="header-actions">
                {!s.virtual && (
                  <>
                    <button className="btn-secondary" onClick={() => startEdit(s)}>
                      Edit
                    </button>
                    <button className="btn-danger" onClick={() => remove(s.slug)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2 className="dashboard-section-title">WorkFM: Announcements &amp; Ads</h2>
      <p className="muted">
        Announcements play solo every 30 minutes of playback; ad breaks play 2 random ads back-to-back every hour.
        Both are unskippable and shown to listeners as "ANNOUNCEMENT"/"ADVERTISEMENT".
      </p>
      {announcementError && <div className="error">{announcementError}</div>}
      <div className="announcement-sections">
        <div className="announcement-section">
          <h3>Announcements</h3>
          <div className="header-actions">
            <input ref={announcementFileInput} type="file" accept=".mp3,audio/mpeg" />
            <button
              className="btn-secondary"
              disabled={uploadingAnnouncement}
              onClick={() => uploadAnnouncementFile("announcement", announcementFileInput.current)}
            >
              {uploadingAnnouncement ? "Uploading…" : "Upload"}
            </button>
          </div>
          <ul className="announcement-file-list">
            {announcements.length === 0 && <li className="muted">No announcement files uploaded yet.</li>}
            {announcements.map((a) => (
              <li key={a.id}>
                <span>{a.title}</span>
                <button className="btn-danger" onClick={() => removeAnnouncementFile(a.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="announcement-section">
          <h3>Ads</h3>
          <div className="header-actions">
            <input ref={adFileInput} type="file" accept=".mp3,audio/mpeg" />
            <button className="btn-secondary" disabled={uploadingAd} onClick={() => uploadAnnouncementFile("ad", adFileInput.current)}>
              {uploadingAd ? "Uploading…" : "Upload"}
            </button>
          </div>
          <ul className="announcement-file-list">
            {ads.length === 0 && <li className="muted">No ad files uploaded yet.</li>}
            {ads.map((a) => (
              <li key={a.id}>
                <span>{a.title}</span>
                <button className="btn-danger" onClick={() => removeAnnouncementFile(a.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
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
