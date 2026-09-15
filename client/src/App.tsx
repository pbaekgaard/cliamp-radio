import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import ChangePasswordModal from "./components/ChangePasswordModal";
import ListenersGlobe from "./components/ListenersGlobe";
import NavCorner from "./components/NavCorner";
import UpdateBanner from "./components/UpdateBanner";
import Dashboard from "./pages/Dashboard";
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
      <NavCorner />
      <UpdateBanner />
      {username && mustChangePassword && <ChangePasswordModal />}
      <Routes>
        <Route path="/" element={<ListenersGlobe />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
