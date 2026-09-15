import { useEffect, useState } from "react";
import { api, type UpdateStatus } from "../api";

export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await api.updateCheck();
        if (!cancelled) setStatus(res);
      } catch {
        // ignore — GitHub may be unreachable or no releases exist yet
      }
    }
    poll();
    const id = setInterval(poll, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status?.updateAvailable || dismissed) return null;

  async function install() {
    setInstalling(true);
    setInstallLog(null);
    try {
      const res = await api.updateInstall();
      setInstallLog(res.log);
    } catch (err) {
      setInstallLog(err instanceof Error ? err.message : String(err));
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
