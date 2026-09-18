import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";

export default function TopBar() {
  const { username } = useAuth();
  const location = useLocation();

  // Dashboard has its own header (with sign-out, update check, etc.), so it
  // doesn't need the site-wide bar duplicating that on top of it.
  if (location.pathname === "/dashboard") return null;

  return (
    <header className="topbar">
      <Link className="topbar-brand" to="/">
        <img className="topbar-logo" src="/favicon.svg" alt="" width={36} height={36} />
        <span className="topbar-brand-text">
          <span className="topbar-brand-name">CLIAMP RADIO</span>
          <span className="topbar-brand-by">by baekgaard.dev</span>
        </span>
      </Link>
      <div className="topbar-actions">
        {!location.pathname.startsWith("/workfm") && (
          <Link className="btn-secondary" to="/workfm">
            WorkFM
          </Link>
        )}
        {location.pathname === "/login" ? (
          <Link className="btn-secondary" to="/">
            View public page
          </Link>
        ) : username ? (
          <Link className="btn-secondary" to="/dashboard">
            Dashboard
          </Link>
        ) : (
          <Link className="btn-secondary" to="/login">
            Admin login
          </Link>
        )}
      </div>
    </header>
  );
}
