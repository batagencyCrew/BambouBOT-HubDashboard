import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Eye, FilePlus2, History, Plus, Save, ShieldAlert, Trash2, X } from "lucide-react";
import { api, ApiError, errorMessage, qs } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useToast } from "../../lib/toast";
import { fmtDate } from "../../lib/format";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { EnvItem, FileHistoryEntry, FileView, ManagedFile, ProxyEntry } from "../../lib/types";
import { ConfirmDialog } from "../../components/Confirm";
import { JsonBlock, isEmptyJson } from "../../components/JsonBlock";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, IconButton, Modal, Spinner, Table, type Column } from "../../components/ui";

const JSON_FORMATS = new Set(["json", "proxy-json"]);
const FORMATS = ["text", "env", "json", "proxies", "proxy-json"];
const PROXY_FORMATS = new Set(["proxies", "proxy-json"]);

export function FilesTab() {
  const { ref, site } = useSite();
  const { can } = useAuth();
  const toast = useToast();
  const [path, setPath] = useState<string | null>(null);
  const [view, setView] = useState<FileView | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletePath, setDeletePath] = useState<string | null>(null);

  const files = usePolling<ManagedFile[]>((signal) => api.get<ManagedFile[]>(`/sites/${ref}/files`, signal), 15_000, [ref]);
  const canEdit = can("config:edit", site.id);
  const canReveal = can("secrets:reveal", site.id);
  const canProxies = can("proxies:manage", site.id);

  useEffect(() => {
    if (!path && files.data?.length) setPath(files.data[0].path);
    if (path && files.data && files.data.length && !files.data.some((f) => f.path === path)) setPath(files.data[0].path);
  }, [files.data, path]);

  const load = useCallback(
    async (target: string, reveal = false) => {
      setBusy("load");
      setLoadError(null);
      try {
        const data = await api.get<FileView>(`/sites/${ref}/files/content${qs({ path: target, reveal })}`);
        setView(data);
        setContent(data.content);
        setDirty(false);
      } catch (err) {
        setLoadError(errorMessage(err));
        setView(null);
      } finally {
        setBusy(null);
      }
    },
    [ref],
  );

  useEffect(() => {
    if (path) void load(path);
  }, [path, load]);

  async function save(reveal: boolean, overwrite = false) {
    if (!view || !path) return;
    if (jsonError) {
      toast.error(`Invalid JSON: ${jsonError}`);
      return;
    }
    setBusy("save");
    try {
      // Overwrite: take the latest revision as base so our text replaces it deliberately.
      const base = overwrite ? (await api.get<FileView>(`/sites/${ref}/files/content${qs({ path })}`)).revision : view.revision;
      const data = await api.put<FileView>(`/sites/${ref}/files/content${qs({ path })}`, {
        content,
        base_revision: base,
        format: view.format,
      });
      setView(data);
      setContent(data.content);
      setDirty(false);
      setConflict(false);
      toast.success(`Saved ${path} (revision ${data.revision})`);
      files.refresh();
      if (reveal) await load(path, true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function validate() {
    if (!path) return;
    setBusy("validate");
    try {
      const result = await api.post<{ valid: boolean; error?: string; changes?: Record<string, unknown> }>(
        `/sites/${ref}/files/validate${qs({ path })}`,
        { content, format: view?.format },
      );
      if (result.valid) toast.success(`Valid${result.changes && !isEmptyJson(result.changes) ? ` — ${JSON.stringify(result.changes)}` : ""}`);
      else toast.error(result.error ?? "Invalid");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function reveal() {
    if (!path) return;
    if (!window.confirm("Revealing secrets is recorded in the audit log with your username. Continue?")) return;
    await load(path, true);
  }

  async function unmanage() {
    if (!deletePath) return;
    setBusy("delete");
    try {
      await api.del(`/sites/${ref}/files${qs({ path: deletePath })}`);
      toast.success(`${deletePath} is no longer managed`);
      files.refresh();
      setPath(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      setDeletePath(null);
    }
  }

  const isProxy = view ? PROXY_FORMATS.has(view.format) : false;
  const isJson = view ? JSON_FORMATS.has(view.format) : false;
  const jsonError = useMemo(() => {
    if (!isJson || !content.trim()) return null;
    try {
      JSON.parse(content);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [isJson, content]);

  function prettify() {
    try {
      setContent(JSON.stringify(JSON.parse(content), null, 2) + "\n");
      setDirty(true);
    } catch {
      /* jsonError already shows the problem */
    }
  }

  return (
    <div className="editor-layout">
      <Card
        title="Managed files"
        subtitle={`${files.data?.length ?? 0} file(s)`}
        actions={canEdit && <Button size="sm" icon={<FilePlus2 size={13} />} onClick={() => setAddOpen(true)}>Add file</Button>}
        flush
      >
        <ErrorNote error={files.error} />
        <div className="file-list" style={{ padding: 6 }}>
          {(files.data ?? []).map((f) => (
            <button key={f.path} className={`file-item${f.path === path ? " active" : ""}`} onClick={() => setPath(f.path)} aria-current={f.path === path}>
              <span className="file-path truncate">{f.path}</span>
              <span className="file-meta">
                {f.format} · rev {f.revision} · {f.in_sync ? <span style={{ color: "#22c55e" }}>in sync</span> : <span style={{ color: "#f59e0b" }}>pending</span>}
                {f.apply_error ? <span style={{ color: "#ef4444" }}> · apply error</span> : null}
              </span>
            </button>
          ))}
          {files.data && files.data.length === 0 && (
            <EmptyState title="No managed files" hint="Add config.json, .env or a proxies file." />
          )}
        </div>
      </Card>

      <Card
        title={path ? <span className="mono">{path}</span> : "File editor"}
        subtitle={
          view && (
            <span>
              {view.format} · revision {view.revision} · applied {view.applied_revision} · {fmtDate(view.updated_at)}
              {view.apply_error ? <span style={{ color: "#ef4444" }}> · {view.apply_error}</span> : null}
            </span>
          )
        }
        actions={
          path && (
            <>
              {view?.in_sync ? <Badge status="healthy">in sync</Badge> : <Badge status="degraded">not applied</Badge>}
              <Button size="sm" onClick={() => void validate()} loading={busy === "validate"}>Validate</Button>
              <Button size="sm" icon={<History size={13} />} onClick={() => setHistoryOpen(true)}>History</Button>
              {canReveal && !view?.revealed && (
                <Button size="sm" icon={<Eye size={13} />} onClick={() => void reveal()} title="View real secret values (audited)">Reveal secrets</Button>
              )}
              {canEdit && <Button size="sm" icon={<Trash2 size={13} />} variant="ghost" onClick={() => setDeletePath(path)} title="Stop managing this file">Unmanage</Button>}
            </>
          )
        }
      >
        <ErrorNote error={loadError} />
        {busy === "load" && !view && <Spinner />}
        {!path && <EmptyState title="Select a file" hint="Choose a managed file, or add one." />}
        {view && (
          <div className="stack">
            {view.revealed && (
              <div className="notice notice-warn row">
                <ShieldAlert size={14} aria-hidden /> Secrets are revealed — this access is audited.
                <button className="btn btn-ghost btn-sm" onClick={() => path && void load(path, false)}>Hide again</button>
              </div>
            )}
            {conflict && (
              <div className="notice notice-warn row">
                Revision conflict: someone else saved this file after you opened it.
                <Button size="sm" onClick={() => { setConflict(false); void load(view.path); }}>Reload latest</Button>
                <Button size="sm" variant="primary" onClick={() => void save(false, true)}>Overwrite with my version</Button>
              </div>
            )}
            {isProxy && Array.isArray(view.parsed) && (
              <ProxyEditor entries={view.parsed as ProxyEntry[]} refSite={ref} path={view.path} baseRevision={view.revision} canManage={canProxies} onChanged={() => { files.refresh(); void load(view.path); }} />
            )}
            {view.format === "env" && Array.isArray(view.parsed) && (
              <div className="row muted-dim">{(view.parsed as EnvItem[]).length} variables parsed{view.parse_error ? ` · ${view.parse_error}` : ""}</div>
            )}
            {view.format === "json" && view.parsed !== null && (
              <details>
                <summary className="muted-dim">Parsed JSON preview</summary>
                <JsonBlock value={view.parsed} />
              </details>
            )}
            {view.parse_error && <ErrorNote error={`Parse error: ${view.parse_error}`} />}
            <textarea
              className="textarea editor-textarea"
              aria-label={`Contents of ${view.path}`}
              value={content}
              readOnly={!canEdit}
              spellCheck={false}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  if (canEdit) void save(view.revealed);
                }
              }}
            />
            <div className="row-between">
              <span className="muted-dim">
                {content.length} bytes · {content.split("\n").length} lines {dirty ? "· unsaved changes" : ""}
              </span>
              {canEdit ? (
                <span className="row">
                  {isJson && (
                    <>
                      {jsonError ? <span className="sev-critical">JSON: {jsonError}</span> : <span style={{ color: "#22c55e", fontSize: 11.5 }}>valid JSON</span>}
                      <Button size="sm" variant="ghost" disabled={!!jsonError} onClick={prettify}>Format</Button>
                    </>
                  )}
                  <Button variant="primary" icon={<Save size={13} />} loading={busy === "save"} disabled={(!dirty && !conflict) || !!jsonError} onClick={() => void save(view.revealed)}>
                    Save
                  </Button>
                </span>
              ) : (
                <span className="muted-dim">Read-only: you lack config:edit</span>
              )}
            </div>
          </div>
        )}
      </Card>

      {path && <HistoryDrawer open={historyOpen} path={path} onClose={() => setHistoryOpen(false)} onRestored={() => { files.refresh(); void load(path); }} />}
      <AddFileModal open={addOpen} onClose={() => setAddOpen(false)} />
      <ConfirmDialog
        open={deletePath !== null}
        title="Stop managing this file?"
        message={<>The hub will stop syncing <code className="mono">{deletePath}</code>. The copy on the VPS is left untouched.</>}
        confirmLabel="Unmanage"
        danger
        busy={busy === "delete"}
        onClose={() => setDeletePath(null)}
        onConfirm={() => void unmanage()}
      />
    </div>
  );
}

function ProxyEditor({
  entries,
  refSite,
  path,
  baseRevision,
  canManage,
  onChanged,
}: {
  entries: ProxyEntry[];
  refSite: string;
  path: string;
  baseRevision: number;
  canManage: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [removeKey, setRemoveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState("");
  const entryFor = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);

  async function patch(body: Record<string, unknown>, message: string) {
    setBusy(true);
    try {
      await api.patch(`/sites/${refSite}/files/content${qs({ path })}`, { base_revision: baseRevision, ...body });
      toast.success(message);
      setAddOpen(false);
      setRemoveKey(null);
      setLines("");
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const target = removeKey ? entryFor.get(removeKey) : undefined;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Proxy entries ({entries.length})</div>
            <div className="card-sub">Structured edits are applied to the file through PATCH, preserving the rest of the document.</div>
          </div>
          {canManage && <Button size="sm" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>Add proxies</Button>}
        </div>
        <div className="scroll-y" style={{ maxHeight: 220 }}>
          {entries.length === 0 && <div className="card-body"><EmptyState title="No proxy entries" /></div>}
          {entries.map((e) => (
            <div className="proxy-entry" key={e.key}>
              <span className="truncate" title={e.url}>{e.url}</span>
              {canManage && (
                <IconButton label={`Remove proxy ${e.host}:${e.port}`} icon={<Trash2 size={13} />} onClick={() => setRemoveKey(e.key)} />
              )}
            </div>
          ))}
        </div>
      </div>
      <Modal
        open={addOpen}
        title="Add proxies"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!lines.trim()} onClick={() => void patch({ add_proxies: lines.split("\n").map((l) => l.trim()).filter(Boolean) }, "Proxies added")}>
              Add
            </Button>
          </>
        }
      >
        <Field label="One proxy per line" hint="scheme://user:password@host:port — http, https, socks4, socks5">
          <textarea className="textarea" rows={7} value={lines} onChange={(e) => setLines(e.target.value)} placeholder="http://user:pass@1.2.3.4:8080" />
        </Field>
      </Modal>
      <ConfirmDialog
        open={removeKey !== null}
        title="Remove proxy?"
        message={<>Remove <code className="mono">{target?.url ?? removeKey}</code> from <code className="mono">{path}</code>?</>}
        confirmLabel="Remove"
        danger
        busy={busy}
        onClose={() => setRemoveKey(null)}
        onConfirm={() => removeKey && void patch({ remove_proxies: [removeKey] }, "Proxy removed")}
      />
    </>
  );
}

function HistoryDrawer({ open, path, onClose, onRestored }: { open: boolean; path: string; onClose: () => void; onRestored: () => void }) {
  const { ref, site } = useSite();
  const { can } = useAuth();
  const toast = useToast();
  const [restoring, setRestoring] = useState<number | null>(null);
  const history = usePolling<FileHistoryEntry[]>((signal) => (open ? api.get<FileHistoryEntry[]>(`/sites/${ref}/files/history${qs({ path })}`, signal) : Promise.resolve([])), null, [open, ref, path]);

  if (!open) return null;
  const columns: Column<FileHistoryEntry>[] = [
    { key: "rev", header: "Rev", render: (h) => <span className="mono">r{h.revision}</span> },
    {
      key: "action",
      header: "Change",
      render: (h) => (
        <div>
          <div>{h.action}</div>
          <div className="muted-dim">{h.summary ? JSON.stringify(h.summary) : ""}</div>
          <div className="muted-dim">{h.username ?? "agent"} · {fmtDate(h.changed_at)}</div>
        </div>
      ),
    },
    {
      key: "restore",
      header: "",
      render: (h) =>
        can("config:edit", site.id) && (
          <IconButton
            label={`Restore revision ${h.revision}`}
            icon={<Download size={13} />}
            disabled={restoring !== null}
            onClick={async () => {
              setRestoring(h.id);
              try {
                await api.post(`/sites/${ref}/files/restore${qs({ path, revision: h.revision })}`);
                toast.success(`Restored revision ${h.revision}`);
                onRestored();
                history.refresh();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setRestoring(null);
              }
            }}
          />
        ),
    },
  ];
  return (
    <div className="drawer" role="dialog" aria-label={`History of ${path}`}>
      <div className="drawer-head">
        <div>
          <div className="card-title">History</div>
          <div className="mono muted-dim truncate">{path}</div>
        </div>
        <IconButton label="Close history" icon={<X size={16} />} onClick={onClose} />
      </div>
      <div className="drawer-body">
        <ErrorNote error={history.error} />
        <Table dense caption="File history" rowKey={(h) => h.id} rows={history.data ?? []} columns={columns} empty={<EmptyState title="No history yet" />} />
      </div>
    </div>
  );
}

function AddFileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ref } = useSite();
  const toast = useToast();
  const [path, setPath] = useState("");
  const [format, setFormat] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/sites/${ref}/files`, { path: path.trim(), format: format || null, content, secret_keys: [] });
      toast.success(`Created ${path.trim()}`);
      setPath("");
      setContent("");
      setFormat("");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Add managed file"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!path.trim()} onClick={() => void submit()}>Create</Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Path" hint="Relative to the script root, e.g. config.json, .env, proxies.txt">
          <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="config.json" autoFocus />
        </Field>
        <Field label="Format" hint="Guessed from the path when left as auto">
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">auto</option>
            {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
        <Field label="Initial content">
          <textarea className="textarea" rows={8} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
        </Field>
      </div>
    </Modal>
  );
}
