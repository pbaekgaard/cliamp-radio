import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";

export default function TopBar() {
  const { username } = useAuth();
  const location = useLocation();

  // Dashboard has its own header (with sign-out, update check, etc.), so it
  // doesn't need the site-wide bar duplicating that on top of it.
  if (location.pathname === "/dashboard") return null;

  // The room page (RoomPage in WorkFm.tsx) portals its own room name into
  // #topbar-room-title here, replacing the site brand text — this reclaims
  // the vertical space the room's own <h1> used to take, letting the hero
  // card start higher up the page (see RoomPage's header JSX).
  const isRoomPage = location.pathname === "/workfm";

  return (
    <header className="topbar">
      <Link className="topbar-brand" to="/">
        <img className="topbar-logo" src="/favicon.svg" alt="" width={36} height={36} />
        <span className="topbar-brand-text">
          {isRoomPage ? (
            <span id="topbar-room-title" />
          ) : (
            <>
              <span className="topbar-brand-name">CLIAMP RADIO</span>
              <span className="topbar-brand-by">by baekgaard.dev</span>
            </>
          )}
        </span>
      </Link>
      <div className="topbar-actions">
        <div id="topbar-room-actions" className="topbar-room-actions" />
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
