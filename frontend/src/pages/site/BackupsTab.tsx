import { useEffect, useState } from "react";
import { Archive, Download, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { api, apiUrl, errorMessage, qs } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtBytes, fmtDate, fmtAgo } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { Backup, BackupConfig, Destination } from "../../lib/types";
import { ConfirmDialog } from "../../components/Confirm";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, IconButton, Modal, Spinner, Table, Toggle, type Column } from "../../components/ui";

export function BackupsTab() {
  const { site, ref } = useSite();
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [destOpen, setDestOpen] = useState<Destination | "new" | null>(null);
  const [deleteDest, setDeleteDest] = useState<Destination | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);

  const canManage = can("backups:manage", site.id);
  const canRequest = can("backups:request", site.id);
  const canDownload = can("backups:download", site.id);

  const backups = usePolling<Backup[]>((signal) => api.get<Backup[]>(`/sites/${ref}/backups${qs({ limit: 50 })}`, signal), 15_000, [ref]);
  const config = usePolling<BackupConfig>((signal) => api.get<BackupConfig>(`/sites/${ref}/backups/config`, signal), 30_000, [ref]);
  const destinations = usePolling<Destination[]>((signal) => api.get<Destination[]>("/backup-destinations", signal), 60_000);
  const remotes = usePolling<string[]>(
    (signal) => (canManage ? api.get<{ remotes: string[] }>("/backup-remotes", signal).then((r) => r.remotes) : Promise.resolve([])),
    60_000,
  );

  const [form, setForm] = useState({ enabled: false, interval_minutes: 1440, destination_ids: [] as string[], keep_count: 14 });
  useEffect(() => {
    if (config.data) {
      setForm({
        enabled: Boolean(config.data.enabled),
        interval_minutes: config.data.interval_minutes ?? 1440,
        destination_ids: config.data.destination_ids ?? [],
        keep_count: config.data.keep_count ?? 14,
      });
    }
  }, [config.data]);

  async function saveConfig() {
    setBusy("config");
    try {
      await api.put(`/sites/${ref}/backups/config`, form);
      toast.success("Backup schedule saved");
      config.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function requestBackup() {
    setBusy("request");
    try {
      const res = await api.post<{ command_id: string; agent_online: boolean }>(`/sites/${ref}/backups/request`);
      toast.success(res.agent_online ? "Backup requested" : "Backup queued — the agent is offline and will upload when it reconnects");
      backups.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveDestination(d: Omit<Destination, "id">, id?: string) {
    setBusy("dest");
    try {
      if (id) await api.put(`/backup-destinations/${id}`, d);
      else await api.post("/backup-destinations", d);
      toast.success(id ? "Destination updated" : "Destination added");
      setDestOpen(null);
      destinations.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeDestination() {
    if (!deleteDest) return;
    setBusy("dest-delete");
    try {
      await api.del(`/backup-destinations/${deleteDest.id}`);
      toast.success("Destination deleted");
      destinations.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      setDeleteDest(null);
    }
  }

  async function retry(backupId: string) {
    setRetryId(backupId);
    try {
      const res = await api.post<{ requeued: number }>(`/sites/${ref}/backups/${backupId}/retry`);
      toast.success(`${res.requeued} transfer(s) requeued`);
      backups.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetryId(null);
    }
  }

  const backupColumns: Column<Backup>[] = [
    { key: "created", header: "Created", render: (b) => <span className="nowrap">{fmtDate(b.created_at)}</span> },
    { key: "status", header: "Status", render: (b) => <Badge status={b.status} /> },
    { key: "source", header: "Source", render: (b) => <span className="pill">{b.source}</span> },
    { key: "size", header: "Size", align: "right", render: (b) => fmtBytes(b.size_bytes) },
    { key: "file", header: "File", render: (b) => <span className="mono muted truncate" style={{ display: "inline-block", maxWidth: 220 }} title={b.filename}>{b.filename}</span> },
    {
      key: "transfers",
      header: "Transfers",
      render: (b) => (
        <div className="stack" style={{ gap: 2 }}>
          {b.transfers.map((t) => (
            <div key={t.destination} className="row" style={{ gap: 6 }}>
              <Badge status={t.status} dot={false} />
              <span className="mono">{t.destination}</span>
              <span className="muted-dim">attempts {t.attempts}</span>
              {t.status === "failed" && canManage && (
                <IconButton label={`Retry transfer to ${t.destination}`} icon={<RotateCw size={12} />} disabled={retryId === b.id || !b.local_available} onClick={() => void retry(b.id)} />
              )}
              {t.error && <span className="sev-critical truncate" style={{ maxWidth: 200 }} title={t.error}>{t.error}</span>}
            </div>
          ))}
          {b.transfers.length === 0 && <span className="faint">—</span>}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (b) =>
        canDownload && b.local_available ? (
          <a className="btn btn-sm" href={apiUrl(`/sites/${ref}/backups/${b.id}/download`)} aria-label={`Download backup ${b.filename}`}>
            <Download size={12} /> Download
          </a>
        ) : (
          <span className="faint" title={b.local_available ? "Download permission required" : "Archive removed from the hub"}>{b.local_available ? "—" : "cloud only"}</span>
        ),
    },
  ];

  const agentState = config.data?.agent as { last_backup_at?: string; status?: string; running?: boolean } | undefined;

  return (
    <div className="stack">
      <div className="split">
        <Card
          title="Backup schedule"
          subtitle={agentState?.last_backup_at ? `Last backup ${fmtAgo(agentState.last_backup_at)}` : "No backup uploaded yet"}
          actions={
            canRequest && (
              <Button size="sm" variant="primary" icon={<Archive size={13} />} loading={busy === "request"} onClick={() => void requestBackup()} title={site.online ? "Ask the agent to upload a backup now" : "Agent is offline — the request will be queued"}>
                Back up now
              </Button>
            )
          }
        >
          <ErrorNote error={config.error} />
          {!config.data && config.loading ? (
            <Spinner />
          ) : (
            <div className="stack">
              {!site.online && <div className="notice notice-warn">Agent is offline — a backup request will be queued until it reconnects.</div>}
              <div className="form-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                <Field label="Scheduled backups">
                  <span className="row"><Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} label="Enable scheduled backups" disabled={!canManage} /> <span className="muted">{form.enabled ? "enabled" : "disabled"}</span></span>
                </Field>
                <Field label="Interval (minutes)">
                  <input className="input" type="number" min={15} max={43200} value={form.interval_minutes} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, interval_minutes: Number(e.target.value) }))} />
                </Field>
                <Field label="Keep archives">
                  <input className="input" type="number" min={1} max={365} value={form.keep_count} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, keep_count: Number(e.target.value) }))} />
                </Field>
              </div>
              <Field label="Destinations">
                <div className="row">
                  {(destinations.data ?? []).length === 0 && <span className="muted-dim">No destinations configured yet.</span>}
                  {(destinations.data ?? []).map((d) => (
                    <label key={d.id} className="check">
                      <input
                        type="checkbox"
                        disabled={!canManage || !d.enabled}
                        checked={form.destination_ids.includes(d.id)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            destination_ids: e.target.checked ? [...f.destination_ids, d.id] : f.destination_ids.filter((x) => x !== d.id),
                          }))
                        }
                      />
                      {d.name} <span className="faint mono">{d.remote}:{d.folder || ""}</span>
                      {!d.enabled && <span className="pill">disabled</span>}
                    </label>
                  ))}
                </div>
              </Field>
              {canManage && (
                <div className="row">
                  <Button size="sm" variant="primary" loading={busy === "config"} onClick={() => void saveConfig()}>Save schedule</Button>
                  {form.enabled && form.destination_ids.length === 0 && <span className="reveal-warn">Enable at least one destination to enable scheduling.</span>}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card
          title="Destinations"
          subtitle="rclone remotes on the hub"
          actions={canManage && <Button size="sm" icon={<Plus size={13} />} onClick={() => setDestOpen("new")}>Add</Button>}
          flush
        >
          <ErrorNote error={destinations.error} />
          <Table
            dense
            caption="Backup destinations"
            rowKey={(d) => d.id}
            rows={destinations.data ?? []}
            columns={[
              { key: "name", header: "Name", render: (d) => d.name },
              { key: "remote", header: "Remote", render: (d) => <span className="mono">{d.remote}:{d.folder}</span> },
              { key: "enabled", header: "State", render: (d) => <Badge status={d.enabled ? "healthy" : "stopped"}>{d.enabled ? "enabled" : "disabled"}</Badge> },
              {
                key: "actions",
                header: "",
                render: (d) =>
                  canManage && (
                    <span className="row" style={{ gap: 2 }}>
                      <IconButton label={`Edit destination ${d.name}`} icon={<Pencil size={13} />} onClick={() => setDestOpen(d)} />
                      <IconButton label={`Delete destination ${d.name}`} icon={<Trash2 size={13} />} onClick={() => setDeleteDest(d)} />
                    </span>
                  ),
              },
            ]}
            empty={<EmptyState icon={<Archive size={20} />} title="No destinations" hint={canManage ? "Add an rclone remote destination." : "Ask an admin to configure one."} />}
          />
        </Card>
      </div>

      <Card title="Backups" subtitle="Newest first" flush>
        <ErrorNote error={backups.error} />
        <Table caption="Backups" rowKey={(b) => b.id} rows={backups.data ?? []} columns={backupColumns} empty={<EmptyState title="No backups yet" />} />
      </Card>

      <DestinationModal
        open={destOpen !== null}
        destination={destOpen === "new" ? null : destOpen}
        remotes={remotes.data ?? []}
        busy={busy === "dest"}
        onClose={() => setDestOpen(null)}
        onSave={(d) => void saveDestination(d, destOpen && destOpen !== "new" ? destOpen.id : undefined)}
      />
      <ConfirmDialog
        open={deleteDest !== null}
        title="Delete destination?"
        message={<>Remove <b>{deleteDest?.name}</b>? Sites still referencing it must be updated first.</>}
        confirmLabel="Delete"
        danger
        busy={busy === "dest-delete"}
        onClose={() => setDeleteDest(null)}
        onConfirm={() => void removeDestination()}
      />
    </div>
  );
}

function DestinationModal({
  open,
  destination,
  remotes,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  destination: Destination | null;
  remotes: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (d: Omit<Destination, "id">) => void;
}) {
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [folder, setFolder] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(destination?.name ?? "");
    setRemote(destination?.remote ?? remotes[0] ?? "");
    setFolder(destination?.folder ?? "");
    setEnabled(destination?.enabled ?? true);
  }, [open, destination, remotes]);

  return (
    <Modal
      open={open}
      title={destination ? "Edit destination" : "Add destination"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name || !remote} onClick={() => onSave({ name, remote, folder: folder.replace(/^\/+|\/+$/g, ""), enabled })}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Backblaze B2" autoFocus />
        </Field>
        <Field label="rclone remote" hint={remotes.length === 0 ? "No remotes found — configure rclone on the hub first." : undefined}>
          <select className="select" value={remote} onChange={(e) => setRemote(e.target.value)}>
            {remotes.length === 0 && <option value="">—</option>}
            {remotes.map((r) => <option key={r} value={r}>{r}:</option>)}
          </select>
        </Field>
        <Field label="Folder (optional)" hint="Parent folder on the remote; each site gets a subfolder.">
          <input className="input mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="backups/bambou" />
        </Field>
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled</label>
      </div>
    </Modal>
  );
}
