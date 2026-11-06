import { useCallback, useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { api, errorMessage, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { useHubData } from "../lib/hubData";
import type { AuditEntry } from "../lib/types";
import { JsonBlock, isEmptyJson } from "../components/JsonBlock";
import { Button, Card, EmptyState, ErrorNote, Table, type Column } from "../components/ui";

interface AuditPage {
  items: AuditEntry[];
  next_before_id: number | null;
}

export function AuditPage() {
  const { can } = useAuth();
  const { overview } = useHubData();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [site, setSite] = useState("");
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const allowed = can("users:audit");

  const fetchPage = useCallback(
    async (before?: number | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.get<AuditPage>(`/audit${qs({ actor: actor || undefined, action: action || undefined, site: site || undefined, before_id: before || undefined, limit: 100 })}`);
        setRows((prev) => (before ? [...prev, ...page.items] : page.items));
        setNext(page.next_before_id);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [actor, action, site],
  );

  useEffect(() => {
    if (!allowed) return;
    const t = window.setTimeout(() => void fetchPage(null), 250);
    return () => window.clearTimeout(t);
  }, [fetchPage, allowed]);

  if (!allowed) return <Card title="Audit log"><EmptyState icon={<ScrollText size={20} />} title="No access" hint="You need the users:audit permission." /></Card>;

  const columns: Column<AuditEntry>[] = [
    { key: "ts", header: "Time", render: (a) => <span className="nowrap">{fmtDate(a.ts)}</span> },
    { key: "actor", header: "Actor", render: (a) => <span>{a.actor} <span className="pill">{a.source}</span></span> },
    { key: "action", header: "Action", render: (a) => <span className="mono">{a.action}</span> },
    { key: "site", header: "Site", render: (a) => a.site_name ?? (a.site_id ? a.site_id.slice(0, 8) : "—") },
    { key: "target", header: "Target", render: (a) => <span className="mono muted truncate" style={{ display: "inline-block", maxWidth: 200 }} title={a.target ?? ""}>{a.target ?? "—"}</span> },
    { key: "ip", header: "IP", render: (a) => <span className="mono muted">{a.ip || "—"}</span> },
    {
      key: "detail",
      header: "Detail",
      render: (a) =>
        open === a.id ? (
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            {isEmptyJson(a.detail) ? <span className="faint">—</span> : <JsonBlock value={a.detail} />}
          </div>
        ) : isEmptyJson(a.detail) ? (
          <span className="faint">—</span>
        ) : (
          <span className="muted truncate" style={{ display: "inline-block", maxWidth: 340 }}>{JSON.stringify(a.detail)}</span>
        ),
    },
  ];

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">Every change and secret reveal · newest first</p>
        </div>
      </div>
      <Card
        title={`${rows.length} entries`}
        actions={
          <div className="filters">
            <input className="input" placeholder="actor" aria-label="Filter by actor" value={actor} onChange={(e) => setActor(e.target.value)} />
            <input className="input" placeholder="action prefix" aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)} />
            <select className="select" aria-label="Filter by site" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">all sites</option>
              {(overview?.sites ?? []).map((s) => <option key={s.id} value={s.slug}>{s.name}</option>)}
            </select>
            <Button size="sm" onClick={() => void fetchPage(null)}>Refresh</Button>
          </div>
        }
        flush
      >
        <ErrorNote error={error} />
        <Table caption="Audit entries" rowKey={(a) => a.id} rows={rows} columns={columns} onRowClick={(a) => setOpen(open === a.id ? null : a.id)} empty={<EmptyState icon={<ScrollText size={20} />} title="No audit entries match" />} />
        <div style={{ display: "flex", justifyContent: "center", padding: 10 }}>
          {next !== null ? (
            <Button size="sm" loading={loading} onClick={() => void fetchPage(next)}>Load older</Button>
          ) : (
            rows.length > 0 && <span className="muted-dim">End of log</span>
          )}
        </div>
      </Card>
    </div>
  );
}
