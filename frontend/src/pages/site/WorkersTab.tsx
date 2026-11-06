import { useState } from "react";
import { ChevronRight, Users } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtAgo, fmtNumber } from "../../lib/format";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { LogEntry, Page, Worker, WorkerSample } from "../../lib/types";
import { JsonBlock, isEmptyJson } from "../../components/JsonBlock";
import { TimeLineChart } from "../../components/Charts";
import { PeriodSelect } from "../../components/PeriodSelect";
import { Card, EmptyState, ErrorNote, Spinner, Table, WorkerBadge, type Column } from "../../components/ui";
import type { Period } from "../../lib/format";

export function WorkersTab() {
  const { ref } = useSite();
  const [selected, setSelected] = useState<Worker | null>(null);
  const [includeStale, setIncludeStale] = useState(false);
  const workers = usePolling<Worker[]>((signal) => api.get<Worker[]>(`/sites/${ref}/workers${qs({ include_stale: includeStale })}`, signal), 10_000, [ref, includeStale]);

  const columns: Column<Worker>[] = [
    { key: "name", header: "Worker", render: (w) => <span className="mono">{w.name}</span> },
    { key: "status", header: "Status", render: (w) => <WorkerBadge status={w.status} /> },
    {
      key: "reason",
      header: "Detail",
      render: (w) => {
        const detail = w.detail ?? {};
        const reason = (detail.reason ?? detail.message ?? detail.state) as string | undefined;
        if (!reason && isEmptyJson(detail)) return <span className="faint">—</span>;
        return (
          <span className="mono truncate" style={{ display: "inline-block", maxWidth: 320 }} title={JSON.stringify(detail)}>
            {reason ?? JSON.stringify(detail)}
          </span>
        );
      },
    },
    { key: "cpu", header: "CPU", align: "right", render: (w) => `${fmtNumber(w.cpu_percent)}%` },
    { key: "mem", header: "Memory", align: "right", render: (w) => `${fmtNumber(w.memory_mb)} MB` },
    { key: "tasks", header: "Tasks", align: "right", render: (w) => fmtNumber(w.tasks_completed, 0) },
    { key: "seen", header: "Last seen", render: (w) => <span className="nowrap">{fmtAgo(w.last_seen_at)}</span> },
    { key: "open", header: "", render: () => <ChevronRight size={14} aria-hidden /> },
  ];

  if (selected) {
    return <WorkerPanel worker={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <Card
      title="Workers"
      actions={
        <label className="check">
          <input type="checkbox" checked={includeStale} onChange={(e) => setIncludeStale(e.target.checked)} /> include stale (&gt; 1 day)
        </label>
      }
      flush
    >
      <ErrorNote error={workers.error} />
      <Table caption="Workers" rowKey={(w) => w.id} rows={workers.data ?? []} columns={columns} onRowClick={setSelected} empty={<EmptyState icon={<Users size={20} />} title="No workers reported" />} />
    </Card>
  );
}

function WorkerPanel({ worker, onBack }: { worker: Worker; onBack: () => void }) {
  const { ref } = useSite();
  const [period, setPeriod] = useState<Period>("24h");
  const samples = usePolling<WorkerSample[]>(
    (signal) => api.get<WorkerSample[]>(`/sites/${ref}/workers/${worker.id}/samples${qs({ period })}`, signal),
    30_000,
    [ref, worker.id, period],
  );
  const logs = usePolling<Page<LogEntry>>(
    (signal) => api.get<Page<LogEntry>>(`/logs${qs({ site: ref, worker: worker.id, limit: 50 })}`, signal),
    15_000,
    [ref, worker.id],
  );

  const chartData = (samples.data ?? []).map((s) => ({ ts: s.bucket, cpu: s.cpu ?? 0, memory: s.memory ?? 0 }));

  return (
    <div className="stack">
      <div className="row-between">
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>← All workers</button>
          <h2 className="page-title" style={{ fontSize: 16 }}>{worker.name}</h2>
          <WorkerBadge status={worker.status} />
          {worker.pid && <span className="pill">pid {worker.pid}</span>}
        </div>
        <PeriodSelect value={period} onChange={setPeriod} />
      </div>
      <div className="split">
        <Card title="CPU & memory" subtitle={`Bucketed samples · ${period}`}>
          <ErrorNote error={samples.error} />
          {samples.loading && !samples.data ? (
            <Spinner />
          ) : chartData.length === 0 ? (
            <EmptyState title="No samples in this period" />
          ) : (
            <TimeLineChart data={chartData} xKey="ts" series={[{ key: "cpu", label: "CPU %", color: "#38bdf8" }, { key: "memory", label: "Memory MB", color: "#a78bfa" }]} />
          )}
        </Card>
        <Card title="Detail">
          {isEmptyJson(worker.detail) ? <EmptyState title="No detail reported" /> : <JsonBlock value={worker.detail} />}
        </Card>
      </div>
      <Card title="Recent logs" flush>
        <ErrorNote error={logs.error} />
        <div className="scroll-y" style={{ maxHeight: 420 }}>
          {(logs.data?.items ?? []).map((entry) => (
            <div className="log-row" key={entry.id}>
              <span className="log-time">{new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false })}</span>
              <span className={`log-level log-${entry.level}`}>{entry.level}</span>
              <span className="log-worker">{entry.source ?? "—"}</span>
              <span />
              <span className="log-msg">{entry.message}</span>
            </div>
          ))}
          {(logs.data?.items ?? []).length === 0 && <EmptyState title="No recent logs" />}
        </div>
      </Card>
    </div>
  );
}
