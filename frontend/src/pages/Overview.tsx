import { Link } from "react-router-dom";
import { Server } from "lucide-react";
import { useHubData } from "../lib/hubData";
import { fmtAgo, fmtTotals } from "../lib/format";
import { AlertActions } from "../components/AlertActions";
import { SiteCard } from "../components/SiteCard";
import { Card, EmptyState, Spinner } from "../components/ui";
import { CreateSiteButton } from "../components/CreateSite";

function Stat({ label, value, foot, tone }: { label: string; value: React.ReactNode; foot?: React.ReactNode; tone?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` stat-${tone}` : ""}`}>{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function OverviewPage() {
  const { overview, alerts, refresh, lastError } = useHubData();
  if (!overview) return lastError ? <div className="error-note">{lastError}</div> : <Spinner label="Loading overview" />;
  const t = overview.totals;
  const active = alerts.length ? alerts : overview.alerts;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">All sites you can see · refreshes every 10 s</p>
        </div>
        <CreateSiteButton onCreated={refresh} />
      </div>

      <div className="grid-stats">
        <Stat label="Sites" value={t.sites} foot={<><span style={{ color: "#22c55e" }}>{t.healthy} healthy</span> · <span style={{ color: "#f59e0b" }}>{t.degraded} degraded</span> · <span style={{ color: "#ef4444" }}>{t.offline} offline</span></>} />
        <Stat label="Workers running" value={t.workers_running} tone="healthy" />
        <Stat label="Workers idle" value={t.workers_idle} tone="accent" />
        <Stat label="Workers error" value={t.workers_error} tone={t.workers_error ? "offline" : undefined} />
        <Stat label="Errors 24h" value={t.errors_24h} tone={t.errors_24h ? "degraded" : undefined} />
        <Stat label="Cost today" value={<span style={{ fontSize: 17 }}>{fmtTotals(t.cost_today)}</span>} />
      </div>

      <Card title={`Open alerts (${active.length})`} actions={<Link to="/alerts">All alerts →</Link>} flush>
        {active.length === 0 ? (
          <EmptyState title="No open alerts" />
        ) : (
          <div className="alert-strip scroll-y">
            {active.slice(0, 12).map((a) => (
              <div className="alert-item" key={a.id}>
                <span className={`sev-${a.severity} nowrap`} style={{ width: 62 }}>{a.severity}</span>
                <span className="pill">{a.status}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="alert-title truncate">
                    {a.site_id ? <Link to={`/sites/${a.site_id}`}>{a.site_name || "site"}</Link> : <span className="muted">hub</span>} · {a.title}
                  </div>
                  {a.body && <div className="alert-body truncate">{a.body}</div>}
                </div>
                <span className="faint nowrap" style={{ marginLeft: "auto" }}>{fmtAgo(a.opened_at)}</span>
                <AlertActions alert={a} onDone={refresh} />
              </div>
            ))}
          </div>
        )}
      </Card>

      {overview.sites.length === 0 ? (
        <Card><EmptyState icon={<Server size={22} />} title="No sites yet" hint="Use “Add site”, then install bambou-agent on its VPS with the token." /></Card>
      ) : (
        <div className="grid-sites">
          {overview.sites.map((s) => <SiteCard key={s.id} site={s} />)}
        </div>
      )}
    </div>
  );
}
