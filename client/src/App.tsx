import { Navigate, Route, Routes } from "react-router-dom";
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
import Login from "./pages/Login";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return null;
  if (!username) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { username, mustChangePassword } = useAuth();

  return (
    <>
      <TopBar />
      <UpdateBanner />
      {username && mustChangePassword && <ChangePasswordModal />}
      <Routes>
        <Route path="/" element={<ListenersGlobe />} />
        <Route path="/login" element={<Login />} />
        <Route path="/workfm" element={<WorkFm />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
      </Routes>
      <MiniPlayerBar />
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
