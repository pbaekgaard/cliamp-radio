import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext";

export default function NavCorner() {
  const { username } = useAuth();
  const location = useLocation();

  if (location.pathname === "/login" || location.pathname === "/dashboard") return null;

  return (
    <div className="nav-corner">
      {username ? (
        <Link className="btn-secondary" to="/dashboard">
          Dashboard
        </Link>
      ) : (
        <Link className="btn-secondary" to="/login">
          Admin login
        </Link>
      )}
    </div>
  );
}
