import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { DeifProvider } from "./DeifContext";
import { RadioPlayerProvider } from "./RadioPlayerContext";
import { UpdateProvider } from "./UpdateContext";
import ChangePasswordModal from "./components/ChangePasswordModal";
import ListenersGlobe from "./components/ListenersGlobe";
import MiniPlayerBar from "./components/MiniPlayerBar";
import TopBar from "./components/TopBar";
import UpdateBanner from "./components/UpdateBanner";
import Dashboard from "./pages/Dashboard";
import Deif from "./pages/Deif";
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
        <Route path="/deif" element={<Deif />} />
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
      <DeifProvider>
        <RadioPlayerProvider>
          <UpdateProvider>
            <AppRoutes />
          </UpdateProvider>
        </RadioPlayerProvider>
      </DeifProvider>
    </AuthProvider>
  );
}
