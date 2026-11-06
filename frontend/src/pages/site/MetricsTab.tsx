import { useEffect, useState } from "react";
import { LineChart as ChartIcon } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtAgo, fmtNumber, type Period } from "../../lib/format";
import { useSite } from "../../lib/site";
import { useLoad, usePolling } from "../../lib/usePolling";
import type { MetricInfo, MetricSeries } from "../../lib/types";
import { TimeLineChart } from "../../components/Charts";
import { PeriodSelect } from "../../components/PeriodSelect";
import { Card, EmptyState, ErrorNote, Spinner } from "../../components/ui";

export function MetricsTab() {
  const { ref } = useSite();
  const [period, setPeriod] = useState<Period>("24h");
  const [selected, setSelected] = useState<string | null>(null);
  const names = useLoad<MetricInfo[]>((signal) => api.get<MetricInfo[]>(`/sites/${ref}/metrics${qs({ period: "30d" })}`, signal), [ref]);

  useEffect(() => {
    if (!selected && names.data?.length) setSelected(names.data[0].name);
  }, [names.data, selected]);

  const series = usePolling<MetricSeries | null>(
    (signal) => (selected ? api.get<MetricSeries>(`/sites/${ref}/metrics/${encodeURIComponent(selected)}${qs({ period })}`, signal) : Promise.resolve(null)),
    selected ? 30_000 : null,
    [ref, selected, period],
  );

  const values = (series.data?.points ?? []).map((p) => p.value);
  const latest = values.at(-1);

  return (
    <div className="editor-layout">
      <Card title="Metrics" subtitle="Last 30 days" flush>
        <ErrorNote error={names.error} />
        {names.loading && !names.data && <div className="card-body"><Spinner /></div>}
        <div className="file-list" style={{ padding: 6 }} role="listbox" aria-label="Metrics">
          {(names.data ?? []).map((m) => (
            <button key={m.name} role="option" aria-selected={selected === m.name} className={`file-item${selected === m.name ? " active" : ""}`} onClick={() => setSelected(m.name)}>
              <span className="file-path">{m.name}</span>
              <span className="file-meta">{m.kind} · {fmtNumber(m.samples, 0)} samples · {fmtAgo(m.last_ts)}</span>
            </button>
          ))}
        </div>
        {names.data && names.data.length === 0 && <EmptyState icon={<ChartIcon size={20} />} title="No metrics reported" hint="Scripts report metrics with hub.metric(...)" />}
      </Card>
      <Card
        title={selected ?? "Select a metric"}
        subtitle={series.data ? `${series.data.kind ?? "gauge"} · bucket ${series.data.bucket}${latest !== undefined ? ` · latest ${fmtNumber(latest, 2)}` : ""}` : undefined}
        actions={<PeriodSelect value={period} onChange={setPeriod} />}
      >
        <ErrorNote error={series.error} />
        {selected && series.data && series.data.points.length > 0 ? (
          <>
            <TimeLineChart data={series.data.points} xKey="ts" series={[{ key: "value", label: selected }]} height={300} area />
            <div className="row muted-dim" style={{ marginTop: 8, gap: 16 }}>
              <span>min {fmtNumber(Math.min(...values), 2)}</span>
              <span>max {fmtNumber(Math.max(...values), 2)}</span>
              <span>avg {fmtNumber(values.reduce((a, b) => a + b, 0) / values.length, 2)}</span>
              <span>{series.data.points.length} buckets</span>
            </div>
          </>
        ) : selected && series.loading ? (
          <Spinner />
        ) : (
          <EmptyState title={selected ? "No data in this period" : "Pick a metric on the left"} />
        )}
      </Card>
    </div>
  );
}
