import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Health, WorkerStatus } from "../lib/types";

/* ---------------------------------------------------------------- Button */

type Variant = "default" | "primary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
  reason?: string;
}

export function Button({ variant = "default", size = "md", icon, loading, reason, className = "", children, ...rest }: ButtonProps) {
  const cls = ["btn", `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest} disabled={rest.disabled || loading} title={rest.title ?? reason}>
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode }) {
  return (
    <button className="icon-btn" aria-label={label} title={label} {...rest}>
      {icon}
    </button>
  );
}

/* ------------------------------------------------------------------ Card */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  flush,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "" : "card-body"}>{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------------- Table */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  width?: string;
  align?: "left" | "right" | "center";
  mono?: boolean;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
  dense,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  dense?: boolean;
  caption?: string;
}) {
  return (
    <div className="table-wrap">
      <table className={`table${dense ? " table-dense" : ""}`}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? "left" }} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          )}
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              className={onRowClick ? "row-clickable" : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={c.mono ? "mono" : undefined} style={{ textAlign: c.align ?? "left" }}>
                  {c.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- Badge */

const HEALTH_LABEL: Record<string, string> = {
  healthy: "healthy",
  degraded: "degraded",
  offline: "offline",
  idle: "idle",
  stopped: "stopped",
  running: "running",
  error: "error",
  starting: "starting",
  unknown: "unknown",
};

export function statusTone(status: string): string {
  switch (status) {
    case "healthy":
    case "ok":
    case "completed":
    case "running":
    case "open":
      return "healthy";
    case "degraded":
    case "slow":
    case "acknowledged":
    case "partial":
      return "degraded";
    case "offline":
    case "error":
    case "failed":
    case "critical":
    case "blocked":
    case "auth":
    case "timeout":
      return "offline";
    case "idle":
    case "starting":
    case "pending":
    case "delivered":
    case "queued":
    case "muted":
      return "idle";
    default:
      return "stopped";
  }
}

export function Badge({
  status,
  children,
  dot = true,
  tone,
}: {
  status: string;
  children?: ReactNode;
  dot?: boolean;
  tone?: string;
}) {
  return (
    <span className={`badge tone-${tone ?? statusTone(status)}`}>
      {dot && <span className="badge-dot" aria-hidden />}
      {children ?? HEALTH_LABEL[status] ?? status}
    </span>
  );
}

export function HealthBadge({ health }: { health: Health | string }) {
  return <Badge status={health} />;
}

export function WorkerBadge({ status }: { status: WorkerStatus | string }) {
  return <Badge status={status} />;
}

/* ------------------------------------------------------------------ Tabs */

export function Tabs({
  tabs,
  active,
  onChange,
  label = "Sections",
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((t) => t.id === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      onChange(tabs[next].id);
      (e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next])?.focus();
    }
  }
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          className={`tab${tab.id === active ? " tab-active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && <span className="tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- Modal */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} style={{ width }}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Close dialog" icon={<X size={16} />} onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- EmptyState */

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      {error}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

/* ---------------------------------------------------------- Field helpers */

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? " toggle-on" : ""}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle-knob" aria-hidden />
    </button>
  );
}

export function Meter({ value, tone }: { value: number | null | undefined; tone?: string }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  const color = tone ?? (pct >= 90 ? "#ef4444" : pct >= 75 ? "#f59e0b" : "#38bdf8");
  return (
    <span className="meter" aria-hidden>
      <span className="meter-fill" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
