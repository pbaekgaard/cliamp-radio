import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useUpdate } from "../UpdateContext";

export default function UpdateBanner() {
  const { username } = useAuth();
  const { status } = useUpdate();
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Re-show the pill if a newer release shows up after the user dismissed
  // a previous one.
  useEffect(() => {
    setDismissed(false);
  }, [status?.latest?.tagName]);

  if (!status?.updateAvailable || dismissed || !username) return null;

  async function install() {
    setInstalling(true);
    setInstallLog(null);
    setInstallError(null);
    try {
      const res = await api.updateInstall();
      if (res.ok) {
        setInstallLog(`${res.log}\n==> Service is restarting now — this page will go offline for a few seconds.`);
      } else {
        setInstallLog(res.log);
        setInstallError("Update script failed — see output below.");
      }
    } catch (err) {
      // Only reaches here on a real network failure (fetch itself rejected);
      // api.updateInstall() otherwise always resolves with { ok, log }.
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <>
      <button className="update-pill" onClick={() => setOpen(true)}>
        🔔 Update available: {status.latest?.tagName}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => !installing && setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{status.latest?.name}</h2>
            <p className="muted">
              {status.current} → {status.latest?.tagName}
            </p>
            <pre className="release-body">{status.latest?.body}</pre>
            {installError && <p className="error">{installError}</p>}
            {installLog && <pre className="install-log">{installLog}</pre>}
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  setOpen(false);
                  setDismissed(true);
                }}
                disabled={installing}
              >
                Dismiss
              </button>
              <button className="btn-primary" onClick={install} disabled={installing}>
                {installing ? "Installing…" : "Install update"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
