import { useState } from "react";
import { Network, Plus, Trash2 } from "lucide-react";
import { api, errorMessage, qs } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtAgo, fmtNumber, type Period } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { FileView, ManagedFile, ProxyEntry, ProxyHealth } from "../../lib/types";
import { ConfirmDialog } from "../../components/Confirm";
import { PeriodSelect } from "../../components/PeriodSelect";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, IconButton, Modal, Table, type Column } from "../../components/ui";

function rateColor(rate: number | null): string {
  if (rate === null) return "#94a3b8";
  if (rate >= 0.9) return "#22c55e";
  if (rate >= 0.6) return "#f59e0b";
  return "#ef4444";
}

export function ProxiesTab() {
  const { site, ref } = useSite();
  const { can } = useAuth();
  const toast = useToast();
  const [period, setPeriod] = useState<Period>("24h");
  const [addOpen, setAddOpen] = useState(false);
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const health = usePolling<ProxyHealth[]>((signal) => api.get<ProxyHealth[]>(`/sites/${ref}/proxy-health${qs({ period })}`, signal), 30_000, [ref, period]);
  const files = usePolling<ManagedFile[]>((signal) => api.get<ManagedFile[]>(`/sites/${ref}/files`, signal), 30_000, [ref]);
  const proxyFile = files.data?.find((f) => f.format === "proxies" || f.format === "proxy-json") ?? null;
  const proxyView = usePolling<FileView | null>(
    (signal) => (proxyFile ? api.get<FileView>(`/sites/${ref}/files/content${qs({ path: proxyFile.path })}`, signal) : Promise.resolve(null)),
    30_000,
    [ref, proxyFile?.path],
  );
  const entries = Array.isArray(proxyView.data?.parsed) ? (proxyView.data.parsed as ProxyEntry[]) : [];
  const canManage = can("proxies:manage", site.id);

  const columns: Column<ProxyHealth>[] = [
    { key: "label", header: "Proxy", render: (p) => <span className="mono">{p.label ?? p.proxy_key}</span> },
    { key: "state", header: "Last state", render: (p) => <Badge status={p.last_state}>{p.last_state}</Badge> },
    {
      key: "rate",
      header: "Success",
      render: (p) => (
        <span className="rate-bar">
          <span className="rate-track"><span className="rate-fill" style={{ width: `${(p.success_rate ?? 0) * 100}%`, background: rateColor(p.success_rate) }} /></span>
          <span className="mono">{p.success_rate === null ? "—" : `${fmtNumber(p.success_rate * 100, 0)}%`}</span>
        </span>
      ),
    },
    { key: "obs", header: "Obs", align: "right", render: (p) => fmtNumber(p.observations, 0) },
    { key: "ok", header: "OK", align: "right", render: (p) => <span style={{ color: "#22c55e" }}>{p.ok}</span> },
    { key: "blocked", header: "Blocked", align: "right", render: (p) => <span style={{ color: p.blocked ? "#ef4444" : undefined }}>{p.blocked}</span> },
    { key: "auth", header: "Auth", align: "right", render: (p) => <span style={{ color: p.auth ? "#ef4444" : undefined }}>{p.auth}</span> },
    { key: "timeout", header: "Timeout", align: "right", render: (p) => <span style={{ color: p.timeout ? "#f59e0b" : undefined }}>{p.timeout}</span> },
    { key: "detail", header: "Last detail", render: (p) => <span className="muted truncate" style={{ display: "inline-block", maxWidth: 260 }} title={p.last_detail ?? ""}>{p.last_detail ?? "—"}</span> },
    { key: "seen", header: "Last seen", render: (p) => <span className="nowrap">{fmtAgo(p.last_ts)}</span> },
    {
      key: "actions",
      header: "",
      render: (p) =>
        canManage && proxyFile && entries.some((e) => e.key === p.proxy_key) ? (
          <IconButton label={`Remove proxy ${p.label ?? p.proxy_key}`} icon={<Trash2 size={13} />} onClick={() => setRemoveKey(p.proxy_key)} />
        ) : null,
    },
  ];

  async function patch(body: Record<string, unknown>, message: string) {
    if (!proxyFile || !proxyView.data) return;
    setBusy(true);
    try {
      await api.patch(`/sites/${ref}/files/content${qs({ path: proxyFile.path })}`, { base_revision: proxyView.data.revision, ...body });
      toast.success(message);
      setAddOpen(false);
      setRemoveKey(null);
      proxyView.refresh();
      health.refresh();
      files.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Card
        title="Proxy health"
        subtitle={`${health.data?.length ?? 0} proxies observed · ${period}`}
        actions={<PeriodSelect value={period} onChange={setPeriod} />}
        flush
      >
        <ErrorNote error={health.error} />
        <Table caption="Proxy health" rowKey={(p) => p.proxy_key} rows={health.data ?? []} columns={columns} empty={<EmptyState icon={<Network size={20} />} title="No proxy observations in this period" />} />
      </Card>

      <Card
        title="Managed proxies"
        subtitle={proxyFile ? <span className="mono">{proxyFile.path} · revision {proxyFile.revision}</span> : "No proxies file is managed for this site"}
        actions={canManage && proxyFile && <Button size="sm" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>Add proxies</Button>}
        flush
      >
        <ErrorNote error={proxyView.error} />
        <div className="scroll-y" style={{ maxHeight: 320 }}>
          {entries.length === 0 && <div className="card-body"><EmptyState title="No parsed entries" hint={proxyFile ? "The file has no proxy lines yet." : "Add a proxies.txt file in the Files tab."} /></div>}
          {entries.map((e) => (
            <div className="proxy-entry" key={e.key}>
              <span className="truncate" title={e.url}>{e.url}</span>
              <span className="row" style={{ gap: 2 }}>
                <span className="pill">line {e.line}</span>
                {canManage && <IconButton label={`Remove proxy ${e.host}:${e.port}`} icon={<Trash2 size={13} />} onClick={() => setRemoveKey(e.key)} />}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <AddProxiesModal open={addOpen} onClose={() => setAddOpen(false)} busy={busy} onSubmit={(lines) => void patch({ add_proxies: lines }, "Proxies added")} />
      <ConfirmDialog
        open={removeKey !== null}
        title="Remove proxy?"
        message={<>This removes <code className="mono">{removeKey}</code> from <code className="mono">{proxyFile?.path}</code>.</>}
        confirmLabel="Remove"
        danger
        busy={busy}
        onClose={() => setRemoveKey(null)}
        onConfirm={() => removeKey && void patch({ remove_proxies: [removeKey] }, "Proxy removed")}
      />
    </div>
  );
}

function AddProxiesModal({ open, onClose, busy, onSubmit }: { open: boolean; onClose: () => void; busy: boolean; onSubmit: (lines: string[]) => void }) {
  const [text, setText] = useState("");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <Modal
      open={open}
      title="Add proxies"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={lines.length === 0} onClick={() => onSubmit(lines)}>Add {lines.length || ""}</Button>
        </>
      }
    >
      <Field label="One proxy per line" hint="scheme://user:password@host:port">
        <textarea className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="http://user:pass@1.2.3.4:8080" autoFocus />
      </Field>
    </Modal>
  );
}
