import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  Copy,
  Inbox,
  LoaderCircle,
  X,
} from "lucide-react";

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Activity size={25} strokeWidth={2.5} />
      </span>
      <span>
        <strong>
          BAMBOU<span className="brand-dot">.</span>
        </strong>
        <small>AUTOMATION HUB</small>
      </span>
    </div>
  );
}
export function Badge({ value }: { value: string }) {
  return (
    <span className={`badge badge-${value}`}>
      <span />
      {value}
    </span>
  );
}
export function Loading({
  label = "Loading your workspace…",
}: {
  label?: string;
}) {
  return (
    <div className="state">
      <LoaderCircle className="spin" size={26} />
      <span>{label}</span>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="state">
      <span className="empty-icon">
        <Inbox size={25} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}
export function ErrorBanner({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && (
        <button className="button small ghost" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Confirm({
  title,
  children,
  label,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  label: string;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body">
        <div className="confirm-warning">
          <AlertCircle size={23} />
        </div>
        <p className="confirm-copy">{children}</p>
        {error && <ErrorBanner message={error} />}
      </div>
      <div className="modal-footer">
        <button className="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="button danger" onClick={onConfirm} disabled={busy}>
          {busy && <LoaderCircle size={16} className="spin" />}
          {label}
        </button>
      </div>
    </Modal>
  );
}
export function TokenModal({
  token,
  onClose,
}: {
  token: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setError("");
    } catch {
      input.current?.select();
      setError("Clipboard unavailable. Select and copy the token manually.");
    }
  }
  return (
    <Modal
      title="Your agent token"
      subtitle="Copy it now. You won’t be able to view it again."
      onClose={onClose}
    >
      <div className="modal-body">
        <div className="notice">
          <AlertCircle size={18} />
          <span>
            Store this token securely and use it as the site agent’s bearer
            token. Never share it in logs or source control.
          </span>
        </div>
        <label className="field">
          Agent token
          <textarea
            ref={input}
            aria-label="Agent token"
            className="token-value"
            readOnly
            value={token}
            rows={4}
            spellCheck={false}
          />
        </label>
        {error && <ErrorBanner message={error} />}
        <button className="button primary full" onClick={() => void copy()}>
          {copied ? <Check size={17} /> : <Copy size={17} />}
          {copied ? "Copied to clipboard" : "Copy agent token"}
        </button>
      </div>
      <div className="modal-footer">
        <button className="button" onClick={onClose}>
          I’ve saved my token
        </button>
      </div>
    </Modal>
  );
}
export function dateTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
export function relativeTime(value: string | null) {
  if (!value) return "Never connected";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (!Number.isFinite(seconds)) return "Unknown";
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function externalUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
