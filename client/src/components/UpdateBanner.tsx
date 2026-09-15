import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useUpdate } from "../UpdateContext";

export default function UpdateBanner() {
  const { username } = useAuth();
  const { status, openRequestId } = useUpdate();
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);

  // Re-show the pill if a newer release shows up after the user dismissed
  // a previous one.
  useEffect(() => {
    setDismissed(false);
  }, [status?.latest?.tagName]);

  // "Check for updates" (or anything else) can ask us to pop the modal open
  // directly instead of making the user notice/click the pill themselves.
  useEffect(() => {
    if (openRequestId > 0) {
      setDismissed(false);
      setOpen(true);
    }
  }, [openRequestId]);

  // Once the update script has restarted the service, poll until it's back
  // up and then reload the page automatically so the user always ends up on
  // the new version without having to refresh by hand.
  useEffect(() => {
    if (!restarting) return;
    let cancelled = false;
    let sawDown = false;
    let attempts = 0;
    setRestartMessage("Waiting for the service to come back online…");
    const id = setInterval(async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        await api.version();
        if (sawDown) {
          cancelled = true;
          clearInterval(id);
          setRestartMessage("Back online — reloading…");
          window.location.reload();
          return;
        }
      } catch {
        sawDown = true;
      }
      if (attempts > 60) {
        // ~2 minutes without the service coming back — stop polling and let
        // the user refresh manually rather than looping forever.
        cancelled = true;
        clearInterval(id);
        setRestartMessage("Still waiting on the service to restart — try refreshing manually.");
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [restarting]);

  if (!status?.updateAvailable || dismissed || !username) return null;

  async function install() {
    setInstalling(true);
    setInstallLog(null);
    setInstallError(null);
    try {
      const res = await api.updateInstall();
      if (res.ok) {
        setInstallLog(`${res.log}\n==> Service is restarting now — this page will go offline for a few seconds.`);
        setRestarting(true);
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
        <div className="modal-backdrop" onClick={() => !installing && !restarting && setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{status.latest?.name}</h2>
            <p className="muted">
              {status.current} → {status.latest?.tagName}
            </p>
            <pre className="release-body">{status.latest?.body}</pre>
            {installError && <p className="error">{installError}</p>}
            {installLog && <pre className="install-log">{installLog}</pre>}
            {restarting && <p className="muted restart-message">{restartMessage}</p>}
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  setOpen(false);
                  setDismissed(true);
                }}
                disabled={installing || restarting}
              >
                Dismiss
              </button>
              <button className="btn-primary" onClick={install} disabled={installing || restarting}>
                {installing ? "Installing…" : restarting ? "Restarting…" : "Install update"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
