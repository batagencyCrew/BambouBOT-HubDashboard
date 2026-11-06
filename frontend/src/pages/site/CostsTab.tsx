import { useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { api, qs } from "../../lib/api";
import { fmtDate, fmtMoney, fmtNumber, fmtTotals, type Period } from "../../lib/format";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { Balance, CostEvent, CostGroup, CostReport } from "../../lib/types";
import { CategoryBarChart, SERIES_COLORS } from "../../components/Charts";
import { PeriodSelect } from "../../components/PeriodSelect";
import { Card, EmptyState, ErrorNote, Table, type Column } from "../../components/ui";

const GROUP_BY: CostGroup[] = ["day", "provider", "category", "worker"];

export function CostsTab() {
  const { ref } = useSite();
  const [period, setPeriod] = useState<Period>("30d");
  const [groupBy, setGroupBy] = useState<CostGroup>("day");

  const report = usePolling<CostReport>((signal) => api.get<CostReport>(`/costs${qs({ site: ref, period, group_by: groupBy })}`, signal), 30_000, [ref, period, groupBy]);
  const events = usePolling<CostEvent[]>((signal) => api.get<CostEvent[]>(`/costs/events${qs({ site: ref, limit: 200 })}`, signal), 30_000, [ref]);
  const balances = usePolling<Balance[]>((signal) => api.get<Balance[]>(`/balances${qs({ site: ref })}`, signal), 30_000, [ref]);

  const chart = useMemo(() => {
    const rows = report.data?.rows ?? [];
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const byKey = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const key = String(row.key);
      const bucket = byKey.get(key) ?? { key };
      bucket[row.currency] = ((bucket[row.currency] as number) ?? 0) + row.total;
      byKey.set(key, bucket);
    }
    const data = [...byKey.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    return { data, currencies };
  }, [report.data]);

  const eventColumns: Column<CostEvent>[] = [
    { key: "ts", header: "When", render: (e) => <span className="nowrap">{fmtDate(e.ts)}</span> },
    { key: "category", header: "Category", render: (e) => e.category },
    { key: "provider", header: "Provider", render: (e) => <span className="mono">{e.provider}</span> },
    { key: "qty", header: "Quantity", align: "right", render: (e) => (e.quantity === null ? "—" : `${fmtNumber(e.quantity, 2)}${e.unit ? ` ${e.unit}` : ""}`) },
    { key: "amount", header: "Amount", align: "right", render: (e) => fmtMoney(e.amount, e.currency) },
  ];

  return (
    <div className="stack">
      <Card
        title="Costs"
        subtitle={<span>Total: <b>{fmtTotals(report.data?.totals ?? {})}</b> · {period}</span>}
        actions={
          <>
            <select className="select" style={{ width: 130 }} aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as CostGroup)}>
              {GROUP_BY.map((g) => <option key={g} value={g}>by {g}</option>)}
            </select>
            <PeriodSelect value={period} onChange={setPeriod} options={["24h", "7d", "30d"]} />
          </>
        }
      >
        <ErrorNote error={report.error} />
        {chart.data.length === 0 ? (
          <EmptyState title="No cost events in this period" />
        ) : (
          <CategoryBarChart
            data={chart.data}
            xKey="key"
            timeAxis={groupBy === "day"}
            series={chart.currencies.map((c, i) => ({ key: c, label: c, color: SERIES_COLORS[i % SERIES_COLORS.length] }))}
            height={260}
          />
        )}
        {(report.data?.rows.length ?? 0) > 0 && (
          <div style={{ marginTop: 12 }}>
            <Table
              dense
              caption="Cost breakdown"
              rowKey={(r, i) => `${r.key}-${r.currency}-${i}`}
              rows={report.data?.rows ?? []}
              columns={[
                { key: "key", header: groupBy, render: (r) => <span className={groupBy === "day" ? "nowrap" : ""}>{groupBy === "day" ? new Date(r.key).toLocaleDateString() : r.key}</span> },
                { key: "currency", header: "Currency", render: (r) => r.currency },
                { key: "total", header: "Total", align: "right", render: (r) => fmtMoney(r.total, r.currency) },
                { key: "events", header: "Events", align: "right", render: (r) => fmtNumber(r.events, 0) },
                { key: "quantity", header: "Quantity", align: "right", render: (r) => (r.quantity === null ? "—" : fmtNumber(r.quantity, 2)) },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="Balances" subtitle="Latest per provider" flush>
        <ErrorNote error={balances.error} />
        <Table
          dense
          caption="Account balances"
          rowKey={(b, i) => `${b.site_name}-${b.provider}-${b.label ?? ""}-${i}`}
          rows={balances.data ?? []}
          columns={[
            { key: "provider", header: "Provider", render: (b) => <span className="mono">{b.provider}</span> },
            { key: "label", header: "Account", render: (b) => b.label ?? "—" },
            { key: "balance", header: "Balance", align: "right", render: (b) => <span className={b.low ? "sev-critical" : ""}>{fmtMoney(b.balance, b.currency)}</span> },
            { key: "threshold", header: "Low below", align: "right", render: (b) => (b.low_threshold === null ? "—" : fmtMoney(b.low_threshold, b.currency)) },
            { key: "status", header: "", render: (b) => (b.low ? <span className="badge tone-offline"><span className="badge-dot" />low</span> : null) },
            { key: "at", header: "Reported", render: (b) => <span className="nowrap">{fmtDate(b.reported_at)}</span> },
          ]}
          empty={<EmptyState icon={<Wallet size={20} />} title="No balances reported" />}
        />
      </Card>

      <Card title="Recent cost events" flush>
        <ErrorNote error={events.error} />
        <Table dense caption="Recent cost events" rowKey={(e, i) => `${e.ts}-${i}`} rows={events.data ?? []} columns={eventColumns} />
      </Card>
    </div>
  );
}
