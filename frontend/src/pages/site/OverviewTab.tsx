import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtAgo, fmtDate, fmtDuration, fmtNumber, fmtTotals } from "../../lib/format";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { Alert, Command, SiteStats } from "../../lib/types";
import { AlertActions } from "../../components/AlertActions";
import { JsonBlock } from "../../components/JsonBlock";
import { Badge, Card, EmptyState, ErrorNote, KeyValues, Table, Toggle, type Column } from "../../components/ui";

export function OverviewTab() {
  const { site, ref, reload } = useSite();
  const [showRaw, setShowRaw] = useState(false);
  const commands = usePolling<Command[]>((signal) => api.get<Command[]>(`/sites/${ref}/commands${qs({ limit: 25 })}`, signal), 10_000, [ref]);
  const stats = usePolling<SiteStats>((signal) => api.get<SiteStats>(`/sites/${ref}/stats${qs({ period: "24h" })}`, signal), 30_000, [ref]);
  const alerts = usePolling<Alert[]>((signal) => api.get<Alert[]>(`/alerts${qs({ status: "active", site: ref })}`, signal), 10_000, [ref]);

  const proc = site.process ?? {};
  const host = site.host ?? {};

  const commandColumns: Column<Command>[] = [
    { key: "when", header: "When", render: (c) => <span className="nowrap">{fmtDate(c.created_at)}</span> },
    { key: "action", header: "Action", render: (c) => <span className="mono">{c.action}{c.action === "set_workers" ? ` ${String(c.args?.count ?? "")}` : ""}</span> },
    { key: "status", header: "Status", render: (c) => <Badge status={c.status} /> },
    { key: "result", header: "Result", render: (c) => <span className="muted truncate" style={{ display: "inline-block", maxWidth: 360 }} title={c.result ?? ""}>{c.result || "—"}</span> },
    { key: "who", header: "By", render: (c) => <span className="muted">{c.requested_by ?? c.source ?? "—"}</span> },
  ];

  return (
    <div className="stack">
      {alerts.data && alerts.data.length > 0 && (
        <Card title={`Active alerts on this site (${alerts.data.length})`} flush>
          {alerts.data.map((a) => (
            <div className="alert-item" key={a.id}>
              <span className={`sev-${a.severity} nowrap`} style={{ width: 62 }}>{a.severity}</span>
              <span className="pill">{a.status}</span>
              <span className="alert-title">{a.title}</span>
              <span className="alert-body truncate">{a.body}</span>
              <span className="faint nowrap">{fmtAgo(a.opened_at)}</span>
              <AlertActions alert={a} onDone={alerts.refresh} showResolve />
            </div>
          ))}
        </Card>
      )}

      <div className="split">
        <Card title="Process" actions={<label className="check"><Toggle checked={showRaw} onChange={setShowRaw} label="Show raw process JSON" /> raw</label>}>
          {proc.crash_loop && (
            <div className="notice notice-warn row" style={{ marginBottom: 10 }}>
              <AlertTriangle size={14} aria-hidden /> Crash loop: the agent paused automatic restarts after repeated crashes.
            </div>
          )}
          <KeyValues
            items={[
              ["PID", <span className="mono">{proc.pid ?? "—"}</span>],
              ["State", proc.running ? <Badge status="running">running</Badge> : <Badge status="stopped">not running</Badge>],
              ["Uptime", fmtDuration(proc.uptime)],
              ["Restarts", fmtNumber(proc.restarts, 0)],
              ["CPU", proc.cpu_percent !== undefined ? `${fmtNumber(proc.cpu_percent)}%` : "—"],
              ["Memory", proc.memory_mb !== undefined ? `${fmtNumber(proc.memory_mb)} MB` : "—"],
              ["Last exit", <span className="mono">{proc.last_exit === undefined || proc.last_exit === null ? "—" : JSON.stringify(proc.last_exit)}</span>],
            ]}
          />
          {showRaw && <div style={{ marginTop: 10 }}><JsonBlock value={proc} /></div>}
        </Card>

        <Card title="Host">
          <KeyValues
            items={[
              ["CPU", host.cpu_percent !== undefined ? `${fmtNumber(host.cpu_percent)}% · ${host.cpu_count ?? "?"} cores` : "—"],
              ["Load", host.load ? host.load.map((n) => n.toFixed(2)).join(" / ") : "—"],
              ["Memory", host.memory_percent !== undefined ? `${fmtNumber(host.memory_percent)}% of ${fmtNumber(host.memory_total_mb, 0)} MB` : "—"],
              ["Disk", host.disk_percent !== undefined ? `${fmtNumber(host.disk_percent)}% · ${fmtNumber(host.disk_free_gb)} GB free` : "—"],
              ["Host uptime", fmtDuration(host.uptime)],
              ["Agent", site.agent_version || "—"],
              ["SDK", site.capabilities?.sdk || "—"],
            ]}
          />
        </Card>
      </div>

      <Card title="Last 24 hours">
        <ErrorNote error={stats.error} />
        {stats.data && (
          <div className="grid-stats">
            <div className="stat"><div className="stat-label">Logs</div><div className="stat-value">{fmtNumber(stats.data.logs.total, 0)}</div><div className="stat-foot"><span style={{ color: "#f59e0b" }}>{stats.data.logs.warnings} warnings</span> · <span style={{ color: "#ef4444" }}>{stats.data.logs.errors} errors</span></div></div>
            <div className="stat"><div className="stat-label">Tasks completed</div><div className="stat-value">{fmtNumber(stats.data.tasks_completed, 0)}</div></div>
            <div className="stat"><div className="stat-label">Cost</div><div className="stat-value" style={{ fontSize: 17 }}>{fmtTotals(Object.fromEntries(stats.data.costs.map((c) => [c.currency, c.total])))}</div></div>
          </div>
        )}
        {stats.data && stats.data.metrics.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <Table
              dense
              caption="Metric summary over 24 hours"
              rowKey={(m) => m.name}
              rows={stats.data.metrics}
              columns={[
                { key: "name", header: "Metric", render: (m) => <span className="mono">{m.name}</span> },
                { key: "kind", header: "Kind", render: (m) => <span className="pill">{m.kind}</span> },
                { key: "value", header: "Avg / Sum", align: "right", render: (m) => fmtNumber(m.value, 2) },
                { key: "peak", header: "Peak", align: "right", render: (m) => fmtNumber(m.peak, 2) },
                { key: "samples", header: "Samples", align: "right", render: (m) => fmtNumber(m.samples, 0) },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="Commands" subtitle="Most recent first" actions={<button className="btn btn-ghost btn-sm" onClick={() => { commands.refresh(); reload(); }}>Refresh</button>} flush>
        <ErrorNote error={commands.error} />
        <Table caption="Recent commands" rowKey={(c) => c.id} rows={commands.data ?? []} columns={commandColumns} empty={<EmptyState title="No commands yet" />} />
      </Card>
    </div>
  );
}
