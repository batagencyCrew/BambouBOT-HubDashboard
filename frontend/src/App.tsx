import { useEffect } from "react";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./lib/toast";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { OverviewPage } from "./pages/Overview";
import { SitePage } from "./pages/site/SitePage";
import { AlertsPage } from "./pages/alerts/AlertsPage";
import { UsersPage } from "./pages/users/UsersPage";
import { AuditPage } from "./pages/Audit";
import { EmptyState } from "./components/ui";

/** Any 401 anywhere clears the user; this sends the browser to /login. */
function AuthRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const onExpired = () => {
      if (window.location.pathname !== "/login") {
        navigate("/login", { replace: true, state: { from: window.location.pathname } });
      }
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [navigate]);
  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <AuthRedirect />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<Layout />}>
              <Route index element={<OverviewPage />} />
              <Route path="sites/:ref" element={<SitePage />} />
              <Route path="sites/:ref/:tab" element={<SitePage />} />
              <Route path="alerts" element={<AlertsPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="*" element={<EmptyState title="Page not found" hint="Check the address or use the navigation." />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
