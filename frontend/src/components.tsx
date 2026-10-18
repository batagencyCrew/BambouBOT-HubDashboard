import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock3,
  Info,
  Search,
  TriangleAlert,
} from "lucide-react";
import type { Command, HubError, Worker } from "./types";
import { Badge, dateTime, Empty, relativeTime } from "./ui";

export function ErrorList({
  errors,
  onSite,
  compact = false,
}: {
  errors: HubError[];
  onSite?: (id: string) => void;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [page, setPage] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const filtered = errors.filter(
    (error) =>
      (level === "all" || error.level === level) &&
      `${error.message} ${error.site_name} ${error.worker_id || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [currentPage, search, level]);
  return (
    <div className="panel events-panel">
      <div className="events-toolbar">
        <label className="search-box">
          <Search size={16} />
          <input
            aria-label="Search event logs"
            placeholder="Search messages, sites, or workers…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <select
          aria-label="Filter event severity"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value);
            setPage(1);
          }}
        >
          <option value="all">All severities</option>
          <option value="error">Error</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </div>
      <div ref={viewport} className="table-scroll events-table-viewport" tabIndex={0} role="region" aria-label="Event log table">
      {filtered.length ? (
          <table className={`events-table ${compact ? "compact" : ""}`}>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Message</th>
                {onSite && <th>Site</th>}
                {!compact && <th>Worker</th>}
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((error) => (
                <tr key={error.id}>
                  <td>
                    <span className={`severity severity-${error.level}`}>
                      {error.level === "error" ? (
                        <AlertCircle size={15} />
                      ) : error.level === "warning" ? (
                        <TriangleAlert size={15} />
                      ) : (
                        <Info size={15} />
                      )}
                      {error.level}
                    </span>
                  </td>
                  <td className="event-message">{error.message}</td>
                  {onSite && (
                    <td>
                      <button
                        className="table-link"
                        onClick={() => onSite(error.site_id)}
                      >
                        {error.site_name}
                      </button>
                    </td>
                  )}
                  {!compact && (
                    <td>
                      <span
                        className="mono worker-id"
                        title={error.worker_id || undefined}
                      >
                        {error.worker_id || "—"}
                      </span>
                    </td>
                  )}
                  <td className="time-cell" title={dateTime(error.timestamp)}>
                    {relativeTime(error.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
      ) : (
        <Empty title={errors.length ? "No matching events" : "All quiet here"}>
          {errors.length
            ? "Try another search or severity filter."
            : "Reported events will appear here as your agents send them."}
        </Empty>
      )}
      </div>
      <div className="log-pagination">
        <span aria-live="polite">
          Showing {filtered.length ? start + 1 : 0}–{Math.min(start + pageSize, filtered.length)} of {filtered.length} events
        </span>
        <div className="log-pagination-controls">
          <button type="button" className="button small" aria-label="Previous log page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span>Page {currentPage} of {totalPages}</span>
          <button type="button" className="button small" aria-label="Next log page" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div>
      </div>
      <div className="panel-footnote">
        <span>
          {filtered.length} {filtered.length === 1 ? "event" : "events"}
        </span>
        <span>
          {compact
            ? "Latest events reported to the hub"
             : "Latest fetched events · Times shown in your local timezone"}
        </span>
      </div>
    </div>
  );
}

export function Workers({ workers }: { workers: Worker[] }) {
  if (!workers.length)
    return (
      <div className="panel">
        <Empty title="No workers reported yet">
          Connect your agent and send a heartbeat to populate the worker
          snapshot.
        </Empty>
      </div>
    );
  return (
    <div className="panel table-scroll">
      <table>
        <thead>
          <tr>
            <th>Worker</th>
            <th>Status</th>
            <th>CPU usage</th>
            <th>Memory</th>
            <th>Tasks completed</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => (
            <tr key={worker.id}>
              <td>
                <div className="worker-name">
                  <span className="worker-icon">
                    <Bot size={18} />
                  </span>
                  <div>
                    <strong>{worker.name}</strong>
                    <span className="mono" title={worker.id}>
                      {worker.id.slice(0, 12)}
                    </span>
                  </div>
                </div>
              </td>
              <td>
                <Badge value={worker.status} />
              </td>
              <td>
                <div className="cpu-cell">
                  <span>{worker.cpu_percent.toFixed(1)}%</span>
                  <div className="cpu-track">
                    <span
                      style={{
                        width: `${Math.max(0, Math.min(100, worker.cpu_percent))}%`,
                      }}
                    />
                  </div>
                </div>
              </td>
              <td>
                {worker.memory_mb.toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                })}{" "}
                <span className="muted">MB</span>
              </td>
              <td>{worker.tasks_completed.toLocaleString()}</td>
              <td className="time-cell" title={dateTime(worker.last_seen)}>
                {relativeTime(worker.last_seen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Commands({ commands }: { commands: Command[] }) {
  return (
    <div className="panel">
      <div className="panel-heading">
        <div>
          <h3>Command activity</h3>
          <p>Queued actions and agent acknowledgments.</p>
        </div>
        <Clock3 size={19} />
      </div>
      {commands.length ? (
        <div className="command-list">
          {commands.map((command) => (
            <div className="command-row" key={command.id}>
              <span className={`command-icon ${command.status}`}>
                {command.status === "completed" ? (
                  <CheckCircle2 size={18} />
                ) : command.status === "failed" ? (
                  <AlertCircle size={18} />
                ) : (
                  <Clock3 size={18} />
                )}
              </span>
              <div className="command-info">
                <strong>{command.action} workers</strong>
                <span title={dateTime(command.created_at)}>
                  {relativeTime(command.created_at)}
                  <span className="command-id">
                    {" "}
                    · {command.id.slice(0, 8)}
                  </span>
                </span>
                {command.message && <p>{command.message}</p>}
                {command.completed_at && (
                  <span>Finished {dateTime(command.completed_at)}</span>
                )}
              </div>
              <Badge value={command.status} />
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No commands dispatched">
          Start, stop, or restart workers to queue an action for the agent.
        </Empty>
      )}
      <div className="panel-footnote">
        <span>Latest 20 commands</span>
        <span>Pending → Delivered → Completed / Failed</span>
      </div>
    </div>
  );
}
