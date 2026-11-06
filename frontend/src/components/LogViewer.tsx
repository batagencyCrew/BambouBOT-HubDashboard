import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { api, errorMessage, qs } from "../lib/api";
import type { LogEntry, LogLevel, Page } from "../lib/types";
import { JsonBlock, isEmptyJson } from "./JsonBlock";
import { Button, EmptyState, ErrorNote, IconButton } from "./ui";

const LEVELS: LogLevel[] = ["debug", "info", "warning", "error", "critical"];
const PAGE = 200;
const MAX_ROWS = 5000;

interface Filters {
  level: LogLevel;
  worker: string;
  q: string;
}

/** Keyset-paginated log viewer with optional live tail (polls every 3 s and prepends). */
export function LogViewer({ site, workers }: { site?: string; workers?: { id: string; name: string }[] }) {
  const [filters, setFilters] = useState<Filters>({ level: "info", worker: "", q: "" });
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<LogEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const rowsRef = useRef<LogEntry[]>([]);
  rowsRef.current = rows;

  const params = useCallback(
    (extra: Record<string, string | number | undefined> = {}) =>
      qs({ site, level: filters.level, worker: filters.worker || undefined, q: filters.q || undefined, limit: PAGE, ...extra }),
    [site, filters],
  );

  // Debounce the free-text search into filters.
  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.q === query ? f : { ...f, q: query })), 350);
    return () => window.clearTimeout(t);
  }, [query]);

  // Initial page whenever filters change.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<Page<LogEntry>>(`/logs${params()}`, controller.signal)
      .then((page) => {
        setRows(page.items);
        setNextBefore(page.next_before_id);
        setExpanded(new Set());
      })
      .catch((err) => {
        if (!(err instanceof DOMException)) setError(errorMessage(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [params]);

  // Live tail: fetch the newest page and prepend rows newer than the top row.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    const tick = async () => {
      controller = new AbortController();
      try {
        const page = await api.get<Page<LogEntry>>(`/logs${params()}`, controller.signal);
        if (cancelled) return;
        const top = rowsRef.current[0]?.id ?? 0;
        const fresh = page.items.filter((r) => r.id > top);
        if (fresh.length) setRows((prev) => [...fresh, ...prev].slice(0, MAX_ROWS));
        setError(null);
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException)) setError(errorMessage(err));
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 3000);
      }
    };
    timer = window.setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [live, params]);

  async function loadOlder() {
    if (nextBefore === null) return;
    setLoading(true);
    try {
      const page = await api.get<Page<LogEntry>>(`/logs${params({ before_id: nextBefore })}`);
      setRows((prev) => [...prev, ...page.items].slice(0, MAX_ROWS));
      setNextBefore(page.next_before_id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="card">
      <div className="log-toolbar">
        <select className="select" style={{ width: 120 }} aria-label="Minimum level" value={filters.level} onChange={(e) => setFilters((f) => ({ ...f, level: e.target.value as LogLevel }))}>
          {LEVELS.map((l) => <option key={l} value={l}>{l}+</option>)}
        </select>
        {workers && (
          <select className="select" style={{ width: 180 }} aria-label="Worker" value={filters.worker} onChange={(e) => setFilters((f) => ({ ...f, worker: e.target.value }))}>
            <option value="">All workers</option>
            {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <input className="input search" style={{ width: 260 }} placeholder="Search messages…" aria-label="Search log messages" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="grow" />
        {live && <span className="row muted-dim"><span className="live-dot" aria-hidden /> live</span>}
        <Button size="sm" icon={live ? <Pause size={13} /> : <Play size={13} />} variant={live ? "primary" : "default"} onClick={() => setLive((v) => !v)} aria-pressed={live}>
          {live ? "Stop tail" : "Live tail"}
        </Button>
        <IconButton label="Reload logs" icon={<RefreshCw size={14} />} onClick={() => setFilters((f) => ({ ...f }))} />
      </div>
      <ErrorNote error={error} />
      <div className="log-list" role="log" aria-live={live ? "polite" : "off"}>
        {rows.length === 0 && !loading && <EmptyState title="No log entries match" hint="Lower the level or clear the search." />}
        {rows.map((r) => {
          const open = expanded.has(r.id);
          return (
            <div key={r.id}>
              <div
                className={`log-row${open ? " expanded" : ""}`}
                onClick={() => toggle(r.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(r.id))}
                tabIndex={0}
                role="button"
                aria-expanded={open}
              >
                <span className="log-time" title={r.ts}>{fmtLogTime(r.ts)}</span>
                <span className={`log-level log-${r.level}`}>{r.level}</span>
                <span className="log-worker" title={r.worker_name ?? ""}>{r.worker_name ?? (site ? "script" : r.site_name)}</span>
                <span className="log-source" title={r.source ?? ""}>{r.source ?? ""}</span>
                <span className="log-msg">{r.message}{r.exception ? <span className="log-error"> ⚠ exception</span> : null}</span>
              </div>
              {open && (
                <div className="log-context stack" style={{ gap: 8 }}>
                  <div className="muted-dim">#{r.id} · {r.ts}{!site && r.site_name ? ` · ${r.site_name}` : ""}</div>
                  {!isEmptyJson(r.context) && <div><div className="field-label">Context</div><JsonBlock value={r.context} /></div>}
                  {r.exception && <div><div className="field-label">Exception</div><pre className="code-block">{r.exception}</pre></div>}
                  {isEmptyJson(r.context) && !r.exception && <span className="muted-dim">No context.</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="log-truncated">
        {nextBefore !== null ? (
          <Button size="sm" loading={loading} onClick={() => void loadOlder()}>Load older</Button>
        ) : (
          rows.length > 0 && <span className="muted-dim">End of results · {rows.length} rows</span>
        )}
      </div>
    </div>
  );
}

function fmtLogTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour12: false });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time.slice(0, 5)}`;
}
