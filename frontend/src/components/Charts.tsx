import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const AXIS = { stroke: "#5b6778", fontSize: 11, tickLine: false } as const;
const GRID = "#1e2835";
const TOOLTIP = {
  contentStyle: { background: "#0f1520", border: "1px solid #263142", borderRadius: 6, fontSize: 12 },
  labelStyle: { color: "#9aa7b8" },
};
export const SERIES_COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#a78bfa", "#ef4444", "#f472b6", "#94a3b8"];

function tickTime(value: string | number) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export interface Series {
  key: string;
  label: string;
  color?: string;
}

export function TimeLineChart({ data, xKey, series, height = 240, area }: { data: Record<string, unknown>[]; xKey: string; series: Series[]; height?: number; area?: boolean }) {
  const Chart = area ? AreaChart : LineChart;
  return (
    <div className="chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tickFormatter={tickTime} minTickGap={40} {...AXIS} />
          <YAxis width={56} {...AXIS} />
          <Tooltip labelFormatter={(v) => tickTime(v as string)} {...TOOLTIP} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) =>
            area ? (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? SERIES_COLORS[i]} fill={s.color ?? SERIES_COLORS[i]} fillOpacity={0.12} dot={false} isAnimationActive={false} />
            ) : (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? SERIES_COLORS[i]} dot={false} strokeWidth={1.6} isAnimationActive={false} />
            ),
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryBarChart({ data, xKey, series, height = 240, timeAxis }: { data: Record<string, unknown>[]; xKey: string; series: Series[]; height?: number; timeAxis?: boolean }) {
  return (
    <div className="chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tickFormatter={timeAxis ? (v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "2-digit" }) : undefined} minTickGap={16} {...AXIS} />
          <YAxis width={56} {...AXIS} />
          <Tooltip cursor={{ fill: "#ffffff08" }} {...TOOLTIP} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color ?? SERIES_COLORS[i % SERIES_COLORS.length]} stackId="a" isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
