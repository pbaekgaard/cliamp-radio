import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Station, type Track, type WorkFmAnnouncementFile, type WorkFmLibraryTrack } from "../api";
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
  const [spisetidFiles, setSpisetidFiles] = useState<WorkFmAnnouncementFile[]>([]);
  const [announcementError, setAnnouncementError] = useState<string | null>(null);
  const [uploadingAnnouncement, setUploadingAnnouncement] = useState(false);
  const [uploadingAd, setUploadingAd] = useState(false);
  const [uploadingSpisetid, setUploadingSpisetid] = useState(false);
  const [addingAdFromYoutube, setAddingAdFromYoutube] = useState(false);
  const [adYoutubeUrl, setAdYoutubeUrl] = useState("");
  const [forcingAd, setForcingAd] = useState(false);
  const [forcingAnnouncement, setForcingAnnouncement] = useState(false);
  const [forcingSpiseTid, setForcingSpiseTid] = useState(false);
  const [stoppingSpiseTid, setStoppingSpiseTid] = useState(false);
  const [forceMessage, setForceMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkFmLibraryTrack[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirmDeleteHistory, setConfirmDeleteHistory] = useState<WorkFmLibraryTrack | null>(null);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null);
  const [promotingHistoryId, setPromotingHistoryId] = useState<string | null>(null);
  const announcementFileInput = useRef<HTMLInputElement>(null);
  const adFileInput = useRef<HTMLInputElement>(null);
  const spisetidFileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setStations(await api.listStations());
  }

  async function refreshAnnouncements() {
    const { announcements, ads, spisetid } = await api.adminListAnnouncements();
    setAnnouncements(announcements);
    setAds(ads);
    setSpisetidFiles(spisetid);
  }

  async function uploadAnnouncementFile(category: "announcement" | "ad" | "spisetid", file: File | null | undefined) {
    if (!file) return;
    setAnnouncementError(null);
    const setUploading = category === "ad" ? setUploadingAd : category === "spisetid" ? setUploadingSpisetid : setUploadingAnnouncement;
    setUploading(true);
    try {
      await api.adminUploadAnnouncement(category, file);
      await refreshAnnouncements();
    } catch (err) {
      setAnnouncementError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function addAdFromYoutube() {
    const url = adYoutubeUrl.trim();
    if (!url) return;
    setAnnouncementError(null);
    setAddingAdFromYoutube(true);
    try {
      await api.adminAddAnnouncementFromYoutube("ad", url);
      setAdYoutubeUrl("");
      await refreshAnnouncements();
    } catch (err) {
      setAnnouncementError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingAdFromYoutube(false);
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

  async function forceAdBreak() {
    setForceMessage(null);
    setForcingAd(true);
    try {
      await api.adminForceAdBreak();
      setForceMessage("Ad break will play next, as soon as the current song finishes.");
    } catch (err) {
      setForceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setForcingAd(false);
    }
  }

  async function forceAnnouncement() {
    setForceMessage(null);
    setForcingAnnouncement(true);
    try {
      await api.adminForceAnnouncement();
      setForceMessage("Announcement will play next, as soon as the current song finishes.");
    } catch (err) {
      setForceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setForcingAnnouncement(false);
    }
  }

  async function forceSpiseTid() {
    setForceMessage(null);
    setForcingSpiseTid(true);
    try {
      await api.adminForceSpiseTid();
      setForceMessage("Spisetid started — alarm now, pause/prefetch shortly, resuming normal playback after.");
    } catch (err) {
      setForceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setForcingSpiseTid(false);
    }
  }

  async function stopSpiseTid() {
    setForceMessage(null);
    setStoppingSpiseTid(true);
    try {
      await api.adminStopSpiseTid();
      setForceMessage("Spisetid stopped — normal playback resumes right away.");
    } catch (err) {
      setForceMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setStoppingSpiseTid(false);
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

  async function refreshHistory() {
    setHistory(await api.adminListHistory());
  }

  async function promoteHistoryEntry(id: string, category: "announcement" | "ad") {
    setHistoryError(null);
    setPromotingHistoryId(id);
    try {
      await api.adminPromoteHistoryEntry(id, category);
      await Promise.all([refreshHistory(), refreshAnnouncements()]);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromotingHistoryId(null);
    }
  }

  async function confirmDeleteHistoryEntry() {
    if (!confirmDeleteHistory) return;
    const id = confirmDeleteHistory.id;
    setHistoryError(null);
    setDeletingHistoryId(id);
    try {
      await api.adminDeleteHistoryEntry(id);
      setConfirmDeleteHistory(null);
      await refreshHistory();
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingHistoryId(null);
    }
  }

  useEffect(() => {
    refresh();
    refreshAnnouncements();
    refreshHistory();
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
      <div className="header-actions">
        <button className="btn-secondary" disabled={forcingAnnouncement} onClick={forceAnnouncement}>
          {forcingAnnouncement ? "Forcing…" : "Force announcement"}
        </button>
        <button className="btn-secondary" disabled={forcingAd} onClick={forceAdBreak}>
          {forcingAd ? "Forcing…" : "Force ad break"}
        </button>
      </div>
      {forceMessage && <p className="muted">{forceMessage}</p>}
      {announcementError && <div className="error">{announcementError}</div>}
      <div className="announcement-sections">
        <div className="announcement-section">
          <h3>Announcements</h3>
          <div className="header-actions">
            <input
              ref={announcementFileInput}
              type="file"
              accept=".mp3,audio/mpeg"
              className="visually-hidden-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                uploadAnnouncementFile("announcement", file);
                e.target.value = ""; // allow re-selecting the same file to re-trigger onChange
              }}
            />
            <button
              className="btn-secondary"
              disabled={uploadingAnnouncement}
              onClick={() => announcementFileInput.current?.click()}
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
            <input
              ref={adFileInput}
              type="file"
              accept=".mp3,audio/mpeg"
              className="visually-hidden-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                uploadAnnouncementFile("ad", file);
                e.target.value = ""; // allow re-selecting the same file to re-trigger onChange
              }}
            />
            <button className="btn-secondary" disabled={uploadingAd} onClick={() => adFileInput.current?.click()}>
              {uploadingAd ? "Uploading…" : "Upload"}
            </button>
          </div>
          <div className="header-actions announcement-youtube-row">
            <input
              placeholder="Or paste a YouTube link…"
              value={adYoutubeUrl}
              onChange={(e) => setAdYoutubeUrl(e.target.value)}
            />
            <button className="btn-secondary" disabled={addingAdFromYoutube || !adYoutubeUrl.trim()} onClick={addAdFromYoutube}>
              {addingAdFromYoutube ? "Downloading…" : "Add from YouTube"}
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

      <h2 className="dashboard-section-title">WorkFM: Spisetid (lunch-break alarm)</h2>
      <p className="muted">
        Every weekday at 11:30 Danish time, Radio Bækgaard pauses for lunch: an alarm sounds until 11:40, then the
        stream stays silent while the request queue is prefetched, and normal playback resumes at 12:00. Upload one or
        more alarm sounds below (falls back to a synthesized siren if none are set). Use "Force" to preview the whole
        cycle right now, or "Stop" to end it immediately (whether forced or the real 11:30 schedule).
      </p>
      <div className="header-actions">
        <button className="btn-secondary" disabled={forcingSpiseTid} onClick={forceSpiseTid}>
          {forcingSpiseTid ? "Forcing…" : "Force spisetid"}
        </button>
        <button className="btn-danger" disabled={stoppingSpiseTid} onClick={stopSpiseTid}>
          {stoppingSpiseTid ? "Stopping…" : "Stop spisetid"}
        </button>
      </div>
      <div className="announcement-section">
        <h3>Alarm sounds</h3>
        <div className="header-actions">
          <input
            ref={spisetidFileInput}
            type="file"
            accept=".mp3,audio/mpeg"
            className="visually-hidden-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              uploadAnnouncementFile("spisetid", file);
              e.target.value = ""; // allow re-selecting the same file to re-trigger onChange
            }}
          />
          <button
            className="btn-secondary"
            disabled={uploadingSpisetid}
            onClick={() => spisetidFileInput.current?.click()}
          >
            {uploadingSpisetid ? "Uploading…" : "Upload"}
          </button>
        </div>
        <ul className="announcement-file-list">
          {spisetidFiles.length === 0 && <li className="muted">No alarm files uploaded yet — a synthesized siren plays instead.</li>}
          {spisetidFiles.map((a) => (
            <li key={a.id}>
              <span>{a.title}</span>
              <button className="btn-danger" onClick={() => removeAnnouncementFile(a.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>

      <h2 className="dashboard-section-title">WorkFM: History</h2>
      <p className="muted">
        Every track that's ever played, most recent first. Download saves the audio locally. "Mark as ad"/"Mark as
        announcement" moves it into that pool below (downloading it again if needed) and removes it from here, so it can
        no longer be queued/requeued as a regular song. Deleting removes it from history/most-liked/most-played
        entirely — it won't affect the request queue on the WorkFM page, which still lets people requeue from history.
      </p>
      {historyError && <div className="error">{historyError}</div>}
      <ul className="announcement-file-list">
        {history.length === 0 && <li className="muted">Nothing's played yet.</li>}
        {history.map((h) => (
          <li key={h.id}>
            <span>
              {h.artist} - {h.title}
            </span>
            <div className="header-actions">
              <a className="btn-secondary" href={api.adminDownloadHistoryEntry(h.id)} download>
                Download
              </a>
              <button
                className="btn-secondary"
                disabled={promotingHistoryId === h.id}
                onClick={() => promoteHistoryEntry(h.id, "announcement")}
              >
                {promotingHistoryId === h.id ? "Working…" : "Mark as announcement"}
              </button>
              <button
                className="btn-secondary"
                disabled={promotingHistoryId === h.id}
                onClick={() => promoteHistoryEntry(h.id, "ad")}
              >
                {promotingHistoryId === h.id ? "Working…" : "Mark as ad"}
              </button>
              <button
                className="btn-danger"
                disabled={deletingHistoryId === h.id}
                onClick={() => setConfirmDeleteHistory(h)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {confirmDeleteHistory && (
        <div className="modal-backdrop" onClick={() => setConfirmDeleteHistory(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Remove from history?</h2>
            <p>
              This permanently removes "{confirmDeleteHistory.artist} - {confirmDeleteHistory.title}" from history,
              most-liked, and most-played (and deletes its saved file, if any). This can't be undone.
            </p>
            {historyError && <div className="error">{historyError}</div>}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteHistory(null)}>
                Cancel
              </button>
              <button
                className="btn-danger"
                disabled={deletingHistoryId === confirmDeleteHistory.id}
                onClick={confirmDeleteHistoryEntry}
              >
                {deletingHistoryId === confirmDeleteHistory.id ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

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
