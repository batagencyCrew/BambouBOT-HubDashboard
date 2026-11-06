import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";
import { useAuth } from "../lib/auth";
import { HubDataProvider, useHubData } from "../lib/hubData";
import { Sidebar } from "./Sidebar";
import { Spinner } from "./ui";

function Topbar({ onToggle }: { onToggle: () => void }) {
  const { connected, lastError } = useHubData();
  return (
    <header className="topbar">
      <button className="icon-btn" onClick={onToggle} aria-label="Toggle navigation">
        <Menu size={16} />
      </button>
      <span className="topbar-spacer" />
      <span className="conn" title={lastError ?? "Polling every 10 s"} role="status">
        <span className={`conn-dot ${connected ? "conn-ok" : "conn-bad"}`} aria-hidden />
        {connected ? "Live" : "Disconnected"}
      </span>
    </header>
  );
}

export function Layout() {
  const { user, checking } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(true);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  if (checking) return <div className="login-wrap"><Spinner label="Connecting to hub" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;

  return (
    <HubDataProvider>
      <div className="shell">
        {navOpen && <Sidebar />}
        <div className="main">
          <Topbar onToggle={() => setNavOpen((v) => !v)} />
          <main className="content">
            <Outlet />
          </main>
        </div>
      </div>
    </HubDataProvider>
  );
}
