import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CloudUpload, Download, HardDrive, LoaderCircle, Pencil, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { api, errorMessage, json } from "./api";
import type { Backup, BackupConfig, BackupHistory, BackupRemotes, BackupRequest, BackupStorage, Destination } from "./backupTypes";
import type { Site } from "./types";
import { Badge, Confirm, dateTime, Empty, ErrorBanner, Loading, Modal } from "./ui";
import { usePolling } from "./usePolling";

function bytes(value: number) {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`;
}

function Schedule({ siteId, config, destinations, onSaved }: {
  siteId: string; config: BackupConfig; destinations: Destination[]; onSaved: () => void;
}) {
  const [form, setForm] = useState(() => ({ enabled: config.enabled, interval: String(config.interval_minutes ?? 1440), ids: config.destination_ids }));
  const dirty = useRef(false);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Only server refreshes synchronize a clean form. Never replace an editing draft.
  useEffect(() => {
    if (!dirty.current) setForm({ enabled: config.enabled, interval: String(config.interval_minutes ?? 1440), ids: config.destination_ids });
  }, [config]);
  function edit(next: typeof form) {
    dirty.current = true;
    setChanged(true);
    setNotice("");
    setForm(next);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    const interval = Number(form.interval);
    if (!Number.isInteger(interval) || interval < 15 || interval > 43200) {
      setError("Choose a whole interval between 15 and 43,200 minutes.");
      return;
    }
    if (form.ids.some((id) => !destinations.some((item) => item.id === id && item.enabled))) {
      setError("Remove unavailable destinations before saving.");
      return;
    }
    if (form.enabled && !form.ids.length) {
      setError("Select at least one enabled cloud destination for periodic backups.");
      return;
    }
    setBusy(true);
    try {
      const saved = await api<BackupConfig>(`/sites/${siteId}/backup-config`, json("PUT", {
        enabled: form.enabled, interval_minutes: interval, destination_ids: form.ids,
      }));
      setForm({ enabled: saved.enabled, interval: String(saved.interval_minutes), ids: saved.destination_ids });
      dirty.current = false;
      setChanged(false);
      setNotice("Backup settings saved. The agent must be configured locally to produce archives.");
      onSaved();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  const missing = form.ids.filter((id) => !destinations.some((item) => item.id === id));
  return <form className="panel backup-schedule" onSubmit={(event) => void save(event)}>
    <div className="panel-heading"><h3>Site backup settings</h3><Badge value={config.enabled ? "enabled" : "disabled"} /></div>
    <div className="backup-body">
      {error && <ErrorBanner message={error} />}
      {notice && <div className="notice" role="status">{notice}</div>}
      <label className="backup-check"><input type="checkbox" role="switch" checked={form.enabled} disabled={busy} onChange={(event) => edit({ ...form, enabled: event.target.checked })} /><span><strong>Periodic backups</strong><small>Ask the configured site agent to upload on a schedule.</small></span></label>
      <label className="field">Interval in minutes<input type="number" required min={15} max={43200} step={1} value={form.interval} disabled={busy} onChange={(event) => edit({ ...form, interval: event.target.value })} /><span className="field-hint">15–43,200 minutes · default 1,440 (daily)</span></label>
      <fieldset className="backup-destinations" disabled={busy}>
        <legend>Cloud destinations for this site</legend>
        <p className="field-hint">Used for scheduled and on-demand backups. Save selections before requesting a backup.</p>
        {!destinations.length && <p className="muted">No destinations yet. Add one in the shared panel below.</p>}
        {destinations.map((destination) => <label className="backup-check" key={destination.id}>
          <input type="checkbox" checked={form.ids.includes(destination.id)} disabled={!destination.enabled && !form.ids.includes(destination.id)} onChange={(event) => edit({ ...form, ids: event.target.checked ? [...form.ids, destination.id] : form.ids.filter((id) => id !== destination.id) })} />
          <span>{destination.name}<small>{destination.remote}:{destination.folder || "/"}{!destination.enabled && " · disabled (remove or re-enable)"}</small></span>
        </label>)}
        {missing.map((id) => <label key={id} className="backup-check"><input type="checkbox" checked onChange={() => edit({ ...form, ids: form.ids.filter((value) => value !== id) })} /><span>Unavailable destination<small>{id} · uncheck to remove</small></span></label>)}
      </fieldset>
      <p className="field-hint">Next agent-reported backup: {dateTime(config.next_backup_at)}. This is telemetry, not evidence of a completed backup.</p>
    </div>
    <div className="backup-footer"><span className="muted" role="status">{changed ? "Unsaved changes · preserved during refresh" : "Settings are saved"}</span><div className="backup-actions">
      {changed && <button type="button" className="button" disabled={busy} onClick={() => { dirty.current = false; setChanged(false); setError(""); setForm({ enabled: config.enabled, interval: String(config.interval_minutes), ids: config.destination_ids }); }}>Discard edits</button>}
      <button className="button primary" disabled={busy || !changed}>{busy && <LoaderCircle size={15} className="spin" />}Save settings</button>
    </div></div>
  </form>;
}

function DestinationEditor({ destination, remotes, onClose, onSaved }: {
  destination: Destination | null; remotes: BackupRemotes; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(destination?.name || "");
  const [remote, setRemote] = useState(destination?.remote || "");
  const [folder, setFolder] = useState(destination?.folder || "");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!remotes.available || !remotes.remotes.includes(remote)) { setError("Choose a remote configured on the hub server."); return; }
    if (!name.trim()) { setError("Enter a destination name."); return; }
    const path = folder.trim();
    if (/[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part.startsWith("-"))) {
      setError("Use a relative cloud folder without traversal, schemes, backslashes, controls, or flags."); return;
    }
    setReview(true);
  }
  async function save() {
    setError("");
    setBusy(true);
    try {
      await api<Destination>(destination ? `/backup-destinations/${destination.id}` : "/backup-destinations", json(destination ? "PATCH" : "POST", { name: name.trim(), remote, folder: folder.trim(), enabled }));
      onSaved(); onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  if (review) return <Confirm title={destination ? "Update shared cloud destination?" : "Add shared cloud destination?"} label={destination ? "Save shared destination" : "Add shared destination"} busy={busy} error={error} onConfirm={() => void save()} onClose={() => { if (!busy) { setError(""); setReview(false); } }}>
    {destination ? "Update" : "Add"} <strong>{name.trim()}</strong> pointing to <strong>{remote}:{folder.trim() || "/"}</strong>, {enabled ? "enabled" : "disabled"} for new transfers? This destination is shared by every site. Existing queued transfers retain their original target snapshot; disabling prevents new transfers from dispatching.
  </Confirm>;
  return <Modal title={destination ? "Edit cloud destination" : "Add cloud destination"} subtitle="Hub-wide · shared by every site" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit}><div className="modal-body">
      {error && <ErrorBanner message={error} />}
      <div className="notice">Changes affect all sites using this destination. Existing queued transfers keep their original target snapshot. Disabling blocks new transfers.</div>
      <label className="field">Destination name<input autoFocus required maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field">Configured remote<select required value={remote} disabled={busy || !remotes.available} onChange={(event) => setRemote(event.target.value)}>
        <option value="">Select a server-configured remote</option>
        {remote && !remotes.remotes.includes(remote) && <option value={remote} disabled>Previously selected remote unavailable</option>}
        {remotes.remotes.map((item) => <option key={item} value={item}>{item}</option>)}
      </select><span className="field-hint">Remote names only. Cloud credentials are never entered here.</span></label>
      <label className="field">Cloud folder (optional)<input maxLength={1000} placeholder="bambou/backups" value={folder} disabled={busy} onChange={(event) => setFolder(event.target.value)} /><span className="field-hint">Relative folder inside the remote. Site and backup IDs are appended automatically.</span></label>
      <label className="backup-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />Enabled for new transfers</label>
    </div><div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !remotes.available || !remotes.remotes.length}>{busy && <LoaderCircle size={15} className="spin" />}{destination ? "Save shared destination" : "Add shared destination"}</button></div></form>
  </Modal>;
}

const requestNotes: Record<BackupRequest["status"], string> = {
  pending: "Queued for the agent; no archive received yet.",
  delivered: "Delivered to the agent; waiting for its archive. Not a cloud upload confirmation.",
  uploaded: "Archive received by the hub. Check cloud transfers in upload history below.",
  failed: "Agent request failed. No cloud completion is implied.",
};
const backupNotes: Record<Backup["status"], string> = {
  uploading: "Receiving archive into the local cache.",
  queued: "Archive staged; cloud transfers queued.",
  transferring: "Copying the staged archive to cloud destinations.",
  completed: "All cloud transfers completed.",
  partial: "Some cloud transfers succeeded; others failed.",
  failed: "Backup failed; no successful cloud completion for all targets.",
};

export default function Backups({ site }: { site: Site }) {
  const base = `/sites/${site.id}`;
  const load = useCallback(async () => {
    const [config, history, destinations, remotes, storage] = await Promise.all([
      api<BackupConfig>(`${base}/backup-config`), api<BackupHistory>(`${base}/backups`),
      api<Destination[]>("/backup-destinations"), api<BackupRemotes>("/backup-remotes"), api<BackupStorage>("/backup-storage"),
    ]);
    return { config, history, destinations, remotes, storage };
  }, [base]);
  const { data, error, refreshing, refresh, updatedAt } = usePolling(load);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ destination: Destination | null } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "evict"; backup: Backup } | { kind: "destination"; destination: Destination } | null>(null);
  const [requestResult, setRequestResult] = useState<BackupRequest | null>(null);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => () => {
    downloadController.current?.abort();
    downloads.current.forEach((timer, url) => { clearTimeout(timer); URL.revokeObjectURL(url); });
    downloads.current.clear();
  }, []);
  async function request() {
    setBusy("request"); setActionError(""); setNotice("");
    try {
      const result = await api<BackupRequest>(`${base}/backups/request`, json("POST", {}));
      setRequestResult(result);
      setNotice(`Request ${result.status}. ${requestNotes[result.status]}`);
      void refresh();
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(""); }
  }
  async function retry(backup: Backup) {
    setBusy(`retry-${backup.id}`); setActionError(""); setNotice("");
    try {
      const result = await api<Backup>(`${base}/backups/${backup.id}/retry`, json("POST", {}));
      setNotice(`Retry accepted (${result.status}). Only failed transfers are retried using their original targets; completed copies are unchanged.`);
      void refresh();
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(""); }
  }
  async function download(backup: Backup) {
    setBusy(`download-${backup.id}`); setActionError("");
    const controller = new AbortController();
    downloadController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const blob = await api<Blob>(`${base}/backups/${backup.id}/download`, { signal: controller.signal }, "blob");
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      // Keep the URL alive briefly for browser download hand-off, then free it.
      const timer = setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 60000);
      downloads.current.set(url, timer);
      const link = document.createElement("a");
      link.href = url; link.download = backup.filename; link.hidden = true;
      document.body.appendChild(link);
      link.click(); link.remove();
      setNotice("Cached file download started. This downloads the hub cache, not a cloud copy.");
    } catch (cause) { if (!controller.signal.aborted) setActionError(errorMessage(cause)); else setActionError("Download cancelled or timed out. Please try again."); }
    finally { clearTimeout(timeout); downloadController.current = null; setBusy(""); }
  }
  async function remove() {
    if (!confirm) return;
    setBusy("remove"); setActionError("");
    try {
      await api<void>(confirm.kind === "evict" ? `${base}/backups/${confirm.backup.id}/local` : `/backup-destinations/${confirm.destination.id}`, json("DELETE"));
      setNotice(confirm.kind === "evict" ? "Local cache evicted. Cloud copies and history are unchanged." : "Shared destination deleted. Existing history is retained.");
      setConfirm(null); void refresh();
    } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(""); }
  }
  function ask(value: NonNullable<typeof confirm>) { setActionError(""); setConfirm(value); }
  if (!data) return error ? <ErrorBanner message={error} retry={() => void refresh()} /> : <Loading label="Loading backups…" />;
  const { config, history, destinations, remotes, storage } = data;
  const validTargets = config.destination_ids.length > 0 && config.destination_ids.every((id) => destinations.some((destination) => destination.id === id && destination.enabled));
  const requests = requestResult && !history.requests.some((item) => item.id === requestResult.id) ? [requestResult, ...history.requests].slice(0, 50) : history.requests;
  const pendingCount = requests.filter((item) => item.status === "pending" || item.status === "delivered").length;
  const latestRequest = requests.find((item) => item.id === requestResult?.id);
  const visibleNotice = notice.startsWith("Request ") && latestRequest
    ? `Request ${latestRequest.status}. ${requestNotes[latestRequest.status]}` : notice;
  return <div className="backups">
    <div className="section-heading inner-heading"><div><h2>Backups</h2><p>Site archive → hub staging cache → selected cloud destinations.</p></div><div className="backup-actions">
      <button className="icon-button" aria-label="Refresh backups" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button>
      <button className="button primary" disabled={!!busy || !validTargets || pendingCount >= 20} onClick={() => void request()}>{busy === "request" ? <LoaderCircle size={16} className="spin" /> : <CloudUpload size={16} />}Request backup</button>
    </div></div>
    {error && <ErrorBanner message={`Backup data may be stale. ${error}`} retry={() => void refresh()} />}
    {actionError && !confirm && <ErrorBanner message={actionError} />}
    {visibleNotice && <div className="notice" role="status">{visibleNotice}</div>}
    {!config.agent_configured && <div className="notice" role="status">Backup source is not configured on this site’s agent. Configure its archive source locally; the dashboard cannot choose files or execute backup commands. A queued request alone does not create an archive.</div>}
    {site.status === "offline" && <div className="notice" role="status">Site agent is offline. Requests wait for reconnection; scheduling and capability reports may be stale.</div>}
    <p className="backup-caption">Backup agent last reported: {dateTime(config.agent_last_seen)}. Requests use saved destinations even when periodic backups are off. {pendingCount >= 20 ? "Pending request limit reached (20)." : !validTargets ? "Save at least one enabled destination to request a backup." : ""}</p>
    <div className="backup-grid">
      <Schedule siteId={site.id} config={config} destinations={destinations} onSaved={() => void refresh()} />
      <div className="panel backup-storage"><div className="panel-heading"><h3>Hub staging storage</h3><HardDrive size={18} /></div><div className="backup-body">
        <strong className="backup-storage-total">{bytes(storage.used_bytes)}<small>of {bytes(storage.max_bytes)} shared quota</small></strong>
        <progress aria-label="Hub staging storage used" max={storage.max_bytes} value={Math.min(storage.used_bytes, storage.max_bytes)} />
        <dl className="backup-facts"><div><dt>Maximum upload</dt><dd>{bytes(storage.max_upload_bytes)}</dd></div><div><dt>Completed cache retention</dt><dd>{storage.retention_days} days</dd></div>{storage.cached_files !== undefined && storage.max_cached_files !== undefined && <div><dt>Cached artifacts</dt><dd>{storage.cached_files.toLocaleString()} / {storage.max_cached_files.toLocaleString()}</dd></div>}</dl>
        <p className="field-hint">Usage includes active upload reservations across all sites. Completed local files expire after retention; failed files are retained for retry or manual eviction.</p>
        <div className="notice">Retention and cache eviction apply only to the hub’s local storage. Cloud copies are never automatically deleted.</div>
      </div></div>
    </div>

    <div className="panel"><div className="panel-heading"><div><h3>Agent requests</h3><p>Delivery is not cloud completion · latest 50 requests</p></div><span className="count">{requests.length}</span></div>
      {requests.length ? <div className="backup-request-list">{requests.map((item) => <div className="backup-request" key={item.id}><div className="backup-row"><Badge value={item.status} /><time>{dateTime(item.created_at)}</time></div><p>{requestNotes[item.status]}</p><small className="mono">Request {item.id}{item.backup_id && ` · Backup ${item.backup_id}`}</small>{item.completed_at && <small className="muted">Completed {dateTime(item.completed_at)}</small>}{item.message && <p className="backup-error">{item.message}</p>}</div>)}</div> : <Empty title="No backup requests">Request an archive from the configured site agent. It appears here before any cloud upload completes.</Empty>}
    </div>

    <div className="panel"><div className="panel-heading"><div><h3>Upload & cloud transfer history</h3><p>Latest 50 uploads · only “completed” confirms every cloud transfer succeeded</p></div></div>
      {history.backups.length ? <div className="backup-history">{history.backups.map((backup) => {
        const active = ["uploading", "queued", "transferring"].includes(backup.status) || backup.transfers.some((transfer) => ["queued", "transferring"].includes(transfer.status));
        const failed = backup.transfers.some((transfer) => transfer.status === "failed");
        const retryEnabled = backup.transfers.filter((transfer) => transfer.status === "failed").every((transfer) => destinations.some((destination) => destination.id === transfer.destination_id && destination.enabled));
        return <article className="backup-record" key={backup.id}>
          <div className="backup-row"><div><h3 className="backup-filename">{backup.filename}</h3><p className="backup-caption">{bytes(backup.size_bytes)} · {backup.source.replaceAll("_", " ")} · {dateTime(backup.created_at)}</p></div><Badge value={backup.status} /></div>
          <p className="backup-caption">{backupNotes[backup.status]} {backup.completed_at && `Finished ${dateTime(backup.completed_at)}.`}</p>
          <details className="backup-integrity"><summary>File integrity & upload ID</summary><p className="mono">ID: {backup.id}</p><p className="mono">SHA-256: {backup.sha256 || "Not available (upload incomplete or failed)"}</p><p className="field-hint">Hash verifies bytes received by the hub, not end-to-end cloud integrity.</p></details>
          {backup.error && <p className="backup-error" role="status">{backup.error}</p>}
          {backup.transfers.length ? <ul className="backup-transfers">{backup.transfers.map((transfer) => <li key={transfer.id}><div className="backup-row"><strong>{transfer.destination_name}</strong><Badge value={transfer.status} /></div><p className="mono">{transfer.remote_path}</p><p className="field-hint">{transfer.attempts} attempt{transfer.attempts === 1 ? "" : "s"}{transfer.completed_at && ` · Finished ${dateTime(transfer.completed_at)}`}</p>{transfer.error && <p className="backup-error">{transfer.error}</p>}</li>)}</ul> : <p className="backup-caption">No cloud transfers recorded yet.</p>}
          <div className="backup-footer"><span className="muted">{backup.local_available ? "Local cache available" : "No local cached file"}</span><div className="backup-actions">
            <button className="button small" disabled={!!busy || !backup.local_available || backup.status === "uploading"} onClick={() => void download(backup)} aria-label={`Download cached ${backup.filename}`} title="Downloads buffer in browser memory. Use rclone for very large cloud backups.">{busy === `download-${backup.id}` ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}Download cache</button>
            {failed && <button className="button small" disabled={!!busy || !backup.local_available || active || !retryEnabled} onClick={() => void retry(backup)} title={!retryEnabled ? "Re-enable the failed destinations before retrying" : !backup.local_available ? "Cached file required for retry" : "Retry failed transfers only"}><RotateCw size={14} />Retry failed</button>}
            <button className="button small danger-outline" disabled={!!busy || !backup.local_available || active} onClick={() => ask({ kind: "evict", backup })} aria-label={`Evict cached ${backup.filename}`}><Trash2 size={14} />Evict cache</button>
          </div></div>
          {failed && (!retryEnabled || !backup.local_available) && <p className="field-hint">{!retryEnabled ? "Re-enable the original failed destinations to retry. " : ""}{!backup.local_available ? "The local cached artifact is required for retry; request a new backup instead." : ""}</p>}
        </article>;
      })}</div> : <Empty title="No uploads received">Agent requests appear separately above. Real uploads and their cloud transfer results will appear here.</Empty>}
    </div>

    <div className="panel"><div className="panel-heading"><div><h3>Cloud destinations <span className="count">Hub-wide</span></h3><p>Shared by all sites · changes here are not site-specific</p></div><button className="button small" disabled={!remotes.available || !remotes.remotes.length || !!busy} onClick={() => setEditor({ destination: null })}><Plus size={15} />Add destination</button></div>
      {(!remotes.available || !remotes.remotes.length || remotes.message) && <div className="backup-body"><div className="notice">{remotes.message || (!remotes.available ? "rclone is unavailable on the hub server." : "No rclone remotes are configured on the hub server.")}</div></div>}
      {destinations.length ? <div className="backup-destination-list">{destinations.map((destination) => <div className="backup-destination" key={destination.id}><div><strong>{destination.name}</strong><p className="mono">{destination.remote}:{destination.folder || "/"}</p></div><Badge value={destination.enabled ? "enabled" : "disabled"} /><div className="backup-actions"><button className="icon-button" aria-label={`Edit shared destination ${destination.name}`} disabled={!!busy} onClick={() => setEditor({ destination })}><Pencil size={16} /></button><button className="icon-button danger-text" aria-label={`Delete shared destination ${destination.name}`} disabled={!!busy} onClick={() => ask({ kind: "destination", destination })}><Trash2 size={16} /></button></div></div>)}</div> : <Empty title="No cloud destinations">Configure an rclone remote on the hub server, then add a shared destination here.</Empty>}
      <div className="backup-body backup-setup"><h3>Operator setup · rclone / Google Drive</h3><ol><li>On the hub server, run <code>rclone config</code> using the hub’s rclone configuration file (<code>HUB_RCLONE_CONFIG</code>). Create a named remote.</li><li>For Google Drive, choose the <code>drive</code> storage provider and complete rclone’s OAuth flow (headless servers can use <code>rclone authorize "drive"</code> on a trusted machine).</li><li>Ensure the hub service can read the configuration and refresh OAuth tokens. Refresh this panel, select the discovered remote, and choose a relative cloud folder.</li></ol><p className="field-hint">Do not paste cloud credentials, tokens, filesystem paths, or shell commands into this dashboard. Credentials remain in the operator-managed server configuration.</p><p className="field-hint">Deleting a destination is refused while referenced by site settings or active transfers. Remove those references first. Cloud files and history are retained.</p></div>
    </div>
    <p className="backup-caption">Backups refresh every 10 seconds while visible{updatedAt ? ` · Last synced ${updatedAt.toLocaleTimeString()}` : ""}.</p>
    {editor && <DestinationEditor destination={editor.destination} remotes={remotes} onClose={() => setEditor(null)} onSaved={() => { setNotice("Shared cloud destination saved. Queued targets keep their original snapshot."); void refresh(); }} />}
    {confirm && <Confirm title={confirm.kind === "evict" ? "Evict local backup cache?" : "Delete shared cloud destination?"} label={confirm.kind === "evict" ? "Evict local cache" : "Delete shared destination"} busy={!!busy} error={actionError} onConfirm={() => void remove()} onClose={() => setConfirm(null)}>{confirm.kind === "evict" ? <>Delete the cached file for <strong>{confirm.backup.filename}</strong>? Downloads and retries will no longer be available. Cloud copies and history are retained. Active uploads or transfers cannot be evicted.</> : <>Delete <strong>{confirm.destination.name}</strong> for every site? This cannot be undone. Cloud files and history are not deleted. The server will refuse deletion if site settings or active transfers still reference it.</>}</Confirm>}
  </div>;
}
