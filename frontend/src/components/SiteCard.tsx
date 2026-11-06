import { Link } from "react-router-dom";
import { Link2, Link2Off } from "lucide-react";
import type { Site } from "../lib/types";
import { fmtAgo, fmtNumber } from "../lib/format";
import { Badge, HealthBadge, Meter } from "./ui";

function Bar({ label, value, suffix = "%" }: { label: string; value: number | undefined; suffix?: string }) {
  return (
    <div className="bar-row">
      <span>{label}</span>
      <Meter value={value} />
      <span className="val">{value === undefined ? "—" : `${fmtNumber(value, 0)}${suffix}`}</span>
    </div>
  );
}

export function SiteCard({ site }: { site: Site }) {
  const w = site.workers;
  return (
    <Link to={`/sites/${site.slug}`} className="site-card" aria-label={`Open site ${site.name}, ${site.health}`}>
      <div className="site-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="site-card-name truncate">{site.name}</div>
          <div className="site-card-meta">{site.slug}</div>
        </div>
        <HealthBadge health={site.health} />
      </div>
      <div className="worker-counts" aria-label="Worker counts">
        <span><b style={{ color: "#22c55e" }}>{w.running ?? 0}</b> running</span>
        <span><b style={{ color: "#38bdf8" }}>{w.idle ?? 0}</b> idle</span>
        <span><b style={{ color: (w.error ?? 0) > 0 ? "#ef4444" : undefined }}>{w.error ?? 0}</b> error</span>
        {(w.stopped ?? 0) > 0 && <span><b style={{ color: "#94a3b8" }}>{w.stopped}</b> stopped</span>}
      </div>
      <div className="site-card-bars">
        <Bar label="CPU" value={site.host?.cpu_percent} />
        <Bar label="Mem" value={site.host?.memory_percent} />
        <Bar label="Disk" value={site.host?.disk_percent} />
      </div>
      <div className="site-card-foot">
        <span className="row" title={site.online ? "Agent socket connected" : "Agent socket not connected"}>
          {site.online ? <Link2 size={13} color="#22c55e" aria-hidden /> : <Link2Off size={13} color="#94a3b8" aria-hidden />}
          {site.online ? "agent linked" : `seen ${fmtAgo(site.last_seen_at)}`}
        </span>
        <Badge status={site.desired_state === "running" ? "running" : site.desired_state === "paused" ? "idle" : "stopped"} dot={false}>
          want: {site.desired_state}
        </Badge>
      </div>
    </Link>
  );
}
