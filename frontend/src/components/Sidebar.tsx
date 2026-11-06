import { NavLink } from "react-router-dom";
import { Bell, LayoutDashboard, LogOut, ScrollText, Users } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useHubData } from "../lib/hubData";
import { colorFor } from "../lib/healthColor";

export function Sidebar() {
  const { user, can, logout } = useAuth();
  const { overview, alerts, connected } = useHubData();
  const sites = overview?.sites ?? [];
  const openAlerts = alerts.filter((a) => a.status === "open").length;
  const linkClass = ({ isActive }: { isActive: boolean }) => `nav-link${isActive ? " active" : ""}`;

  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <div className="brand-mark" aria-hidden>B</div>
        <div>
          <div className="brand-name">Bambou Hub</div>
          <div className="brand-sub">automation control</div>
        </div>
      </div>
      <nav className="nav">
        <NavLink to="/" end className={linkClass}>
          <LayoutDashboard size={15} aria-hidden /> Overview
        </NavLink>
        <NavLink to="/alerts" className={linkClass}>
          <Bell size={15} aria-hidden /> Alerts
          {openAlerts > 0 && (
            <span className="nav-count" aria-label={`${openAlerts} open alerts`}>
              {openAlerts}
            </span>
          )}
        </NavLink>
        {can("users:manage") && (
          <NavLink to="/users" className={linkClass}>
            <Users size={15} aria-hidden /> Users & bots
          </NavLink>
        )}
        {can("users:audit") && (
          <NavLink to="/audit" className={linkClass}>
            <ScrollText size={15} aria-hidden /> Audit log
          </NavLink>
        )}
      </nav>
      <div className="nav-sep" />
      <div className="nav-heading">Sites ({sites.length})</div>
      <nav className="nav" style={{ paddingTop: 0 }} aria-label="Sites">
        {sites.map((site) => (
          <NavLink key={site.id} to={`/sites/${site.slug}`} className={({ isActive }) => `site-link${isActive ? " active" : ""}`}>
            <span className="dot" style={{ background: colorFor(site.health) }} aria-label={site.health} />
            <span className="truncate">{site.name}</span>
          </NavLink>
        ))}
        {sites.length === 0 && <span className="muted-dim" style={{ padding: "4px 12px" }}>No sites</span>}
      </nav>
      <div className="sidebar-foot">
        <span className="row" role="status" aria-live="polite">
          <span className={`conn-dot ${connected ? "conn-ok" : "conn-bad"}`} aria-hidden />
          {connected ? "Connected" : "Hub unreachable"}
        </span>
        <div className="row-between">
          <span className="truncate" title={user?.username}>
            {user?.display_name || user?.username} <span className="faint">· {user?.role}</span>
          </span>
          <button className="icon-btn" onClick={() => void logout()} aria-label="Sign out" title="Sign out">
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
