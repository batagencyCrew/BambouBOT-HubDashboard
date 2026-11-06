import { useState } from "react";
import { Link } from "react-router-dom";
import { BellRing } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtAgo, fmtDate } from "../../lib/format";
import { useHubData } from "../../lib/hubData";
import { usePolling } from "../../lib/usePolling";
import type { Alert } from "../../lib/types";
import { AlertActions } from "../../components/AlertActions";
import { JsonBlock, isEmptyJson } from "../../components/JsonBlock";
import { Badge, Card, EmptyState, ErrorNote, Tabs, Table, type Column } from "../../components/ui";
import { RulesPanel } from "./RulesPanel";
import { DefaultChannels } from "./DefaultChannels";

const STATUSES = ["active", "open", "acknowledged", "muted", "resolved", "all"];
const SEVERITIES = ["", "critical", "warning", "info"];

export function AlertsPage() {
  const [view, setView] = useState("alerts");
  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="page-title">Alerts</h1>
          <p className="page-sub">Deduplicated alerts, rules and delivery channels</p>
        </div>
      </div>
      <Tabs tabs={[{ id: "alerts", label: "Alerts" }, { id: "rules", label: "Rules" }, { id: "channels", label: "Default channels" }]} active={view} onChange={setView} label="Alert sections" />
      {view === "alerts" && <AlertList />}
      {view === "rules" && <RulesPanel />}
      {view === "channels" && <DefaultChannels />}
    </div>
  );
}

function AlertList() {
  const { overview, refresh: refreshHub } = useHubData();
  const [status, setStatus] = useState("active");
  const [severity, setSeverity] = useState("");
  const [site, setSite] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const alerts = usePolling<Alert[]>((signal) => api.get<Alert[]>(`/alerts${qs({ status, site, limit: 500 })}`, signal), 10_000, [status, site]);
  const rows = (alerts.data ?? []).filter((a) => !severity || a.severity === severity);
  const done = () => {
    alerts.refresh();
    refreshHub();
  };

  const columns: Column<Alert>[] = [
    { key: "sev", header: "Severity", render: (a) => <span className={`sev-${a.severity}`}>{a.severity}</span> },
    { key: "status", header: "Status", render: (a) => <Badge status={a.status} /> },
    { key: "site", header: "Site", render: (a) => (a.site_id ? <Link to={`/sites/${a.site_id}`} onClick={(e) => e.stopPropagation()}>{a.site_name || a.site_id.slice(0, 8)}</Link> : <span className="muted">hub</span>) },
    {
      key: "title",
      header: "Alert",
      render: (a) => (
        <div>
          <div>{a.title}</div>
          {a.body && <div className="muted-dim">{a.body}</div>}
          {open === a.id && (
            <div className="stack" style={{ gap: 6, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
              <div className="muted-dim mono">key {a.dedup_key}</div>
              {a.ack_by && <div className="muted-dim">acknowledged by {a.ack_by}</div>}
              {a.muted_until && <div className="muted-dim">muted until {fmtDate(a.muted_until)}</div>}
              {!isEmptyJson(a.data) && <JsonBlock value={a.data} />}
            </div>
          )}
        </div>
      ),
    },
    { key: "opened", header: "Opened", render: (a) => <span className="nowrap" title={fmtDate(a.opened_at)}>{fmtAgo(a.opened_at)}</span> },
    { key: "resolved", header: "Resolved", render: (a) => <span className="nowrap">{a.resolved_at ? fmtAgo(a.resolved_at) : "—"}</span> },
    { key: "actions", header: "", render: (a) => <AlertActions alert={a} onDone={done} showResolve /> },
  ];

  return (
    <Card
      title={`${rows.length} alert(s)`}
      actions={
        <div className="filters">
          <select className="select" aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="select" aria-label="Severity filter" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{s || "any severity"}</option>)}
          </select>
          <select className="select" aria-label="Site filter" value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">all sites</option>
            {(overview?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      }
      flush
    >
      <ErrorNote error={alerts.error} />
      <Table caption="Alerts" rowKey={(a) => a.id} rows={rows} columns={columns} onRowClick={(a) => setOpen(open === a.id ? null : a.id)} empty={<EmptyState icon={<BellRing size={20} />} title="No alerts match" />} />
    </Card>
  );
}
