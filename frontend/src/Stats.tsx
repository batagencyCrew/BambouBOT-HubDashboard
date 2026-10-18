import { useCallback } from "react";
import { BarChart3, Link, MessagesSquare, Radio } from "lucide-react";
import { api } from "./api";
import type { Site, Statistics } from "./types";
import { dateTime, ErrorBanner, Loading } from "./ui";
import { usePolling } from "./usePolling";

export default function Stats({ site }: { site: Site }) {
  const load = useCallback(
    () => api<Statistics>(`/sites/${site.id}/statistics`),
    [site.id],
  );
  const { data, error, refresh, updatedAt } = usePolling(load);
  const format = (value: number | null | undefined) =>
    value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <section className="statistics-section" aria-label="Site statistics">
      <div className="section-heading inner-heading">
        <div>
          <h2><BarChart3 size={18} aria-hidden="true" /> STATISTICS</h2>
          <p>Automation-reported whole-site snapshot · Refreshes every 10 seconds</p>
        </div>
      </div>
      {error && (
        <ErrorBanner
          message={`Statistics unavailable${data ? "; showing the last retrieved snapshot" : ""}. ${error}`}
          retry={() => void refresh()}
        />
      )}
      {!data && !error && <Loading label="Loading statistics…" />}
      <div className="statistics-grid">
        <div className="detail-stat">
          <span><Link size={17} />Links Sent Successfully</span>
          <strong>{format(data?.links_sent_successfully)}</strong>
        </div>
        <div className="detail-stat">
          <span><MessagesSquare size={17} />Average Messages Per Chat</span>
          <strong>{format(data?.average_messages_per_chat)}</strong>
        </div>
      </div>
      {data && (
        <p className="statistics-timestamp">
          {data.updated_at ? <>Last reported: <time dateTime={data.updated_at}>{dateTime(data.updated_at)}</time> (local time)</> : "No statistics reported yet."}
          {data.average_messages_per_chat === null && data.updated_at && " Average unavailable: no chats or unknown."}
        </p>
      )}
      {updatedAt && <p className="statistics-timestamp">Last checked: {updatedAt.toLocaleTimeString()} (local time)</p>}
      {site.status === "offline" && (
        <div className="notice" role="status">
          <Radio size={17} />
          <span>This site is offline. Reported statistics are historical snapshots, not live activity.</span>
        </div>
      )}
    </section>
  );
}
