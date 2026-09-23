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
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  // Tracks whether the *service* is actually bouncing (vs. just reloading
  // this tab to pick up a client-only build that needed no restart at all)
  // — the countdown/reload behavior is shared, but the button/status text
  // shouldn't claim a restart happened when it didn't.
  const [serviceRestarting, setServiceRestarting] = useState(false);

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

  // A simple fixed countdown after a successful install, rather than
  // polling for the service to come back — the server schedules its own
  // restart shortly after responding, so by the time a short countdown
  // elapses it's reliably back up, without the false starts that come from
  // trying to detect "down, then up" through a reverse proxy.
  useEffect(() => {
    if (restartCountdown === null) return;
    if (restartCountdown <= 0) {
      window.location.reload();
      return;
    }
    const id = setTimeout(() => setRestartCountdown((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(id);
  }, [restartCountdown]);

  if (!status?.updateAvailable || dismissed || !username) return null;

  async function install() {
    setInstalling(true);
    setInstallLog(null);
    setInstallError(null);
    try {
      const res = await api.updateInstall();
      if (res.ok) {
        if (res.restartRequired) {
          setServiceRestarting(true);
          setInstallLog(`${res.log}\n==> Service is restarting now — this page will reload automatically.`);
          setRestartCountdown(3);
        } else {
          // Client-only release — nothing to restart, so no interruption to
          // WorkFM listeners or any other live stream. Just reload this page
          // to pick up the new build.
          setServiceRestarting(false);
          setInstallLog(`${res.log}\n==> Applied without restarting the service — no listeners were interrupted.`);
          setRestartCountdown(1);
        }
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

  // Whether a page reload is pending — true for both a real service
  // restart and a client-only apply, since either way this tab needs a
  // fresh load to pick up the new build.
  const reloading = restartCountdown !== null;

  return (
    <>
      <button className="update-pill" onClick={() => setOpen(true)}>
        🔔 Update available: {status.latest?.tagName}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => !installing && !reloading && setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{status.latest?.name}</h2>
            <p className="muted">
              {status.current} → {status.latest?.tagName}
            </p>
            <pre className="release-body">{status.latest?.body}</pre>
            {installError && <p className="error">{installError}</p>}
            {installLog && <pre className="install-log">{installLog}</pre>}
            {reloading && <p className="muted restart-message">Reloading in {restartCountdown}…</p>}
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  setOpen(false);
                  setDismissed(true);
                }}
                disabled={installing || reloading}
              >
                Dismiss
              </button>
              <button className="btn-primary" onClick={install} disabled={installing || reloading}>
                {installing ? "Installing…" : reloading ? (serviceRestarting ? "Restarting…" : "Applying…") : "Install update"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
