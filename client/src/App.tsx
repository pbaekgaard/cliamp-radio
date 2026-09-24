import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { WorkFmProvider } from "./WorkFmContext";
import { RadioPlayerProvider } from "./RadioPlayerContext";
import { UpdateProvider } from "./UpdateContext";
import ChangePasswordModal from "./components/ChangePasswordModal";
import ListenersGlobe from "./components/ListenersGlobe";
import MiniPlayerBar from "./components/MiniPlayerBar";
import TopBar from "./components/TopBar";
import UpdateBanner from "./components/UpdateBanner";
import Dashboard from "./pages/Dashboard";
import WorkFm from "./pages/WorkFm";
import WorkFmChat from "./pages/WorkFmChat";
import WorkFmKiosk from "./pages/WorkFmKiosk";
import Login from "./pages/Login";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return null;
  if (!username) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { username, mustChangePassword } = useAuth();
  const location = useLocation();
  // The kiosk view is meant to run full-screen, unattended, on a tablet —
  // none of the site chrome (nav bar, update pill, mini player) makes sense
  // there. The standalone chat page is the same deal — it's meant to be a
  // fullscreen chat-only window, not another place to see the nav/player.
  const isKiosk = location.pathname === "/workfm/kiosk_view";
  const isChatFullscreen = location.pathname === "/workfm/chat";
  const hideChrome = isKiosk || isChatFullscreen;

  return (
    <>
      {!hideChrome && <TopBar />}
      {!hideChrome && <UpdateBanner />}
      {username && mustChangePassword && <ChangePasswordModal />}
      <Routes>
        <Route path="/" element={<ListenersGlobe />} />
        <Route path="/login" element={<Login />} />
        <Route path="/workfm" element={<WorkFm />} />
        <Route path="/workfm/chat" element={<WorkFmChat />} />
        <Route path="/workfm/kiosk_view" element={<WorkFmKiosk />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
      </Routes>
      {!hideChrome && <MiniPlayerBar />}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <WorkFmProvider>
        <RadioPlayerProvider>
          <UpdateProvider>
            <AppRoutes />
          </UpdateProvider>
        </RadioPlayerProvider>
      </WorkFmProvider>
    </AuthProvider>
  );
}
