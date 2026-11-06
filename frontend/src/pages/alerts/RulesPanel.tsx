import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useHubData } from "../../lib/hubData";
import { useToast } from "../../lib/toast";
import { useLoad } from "../../lib/usePolling";
import type { AlertRule, Channel } from "../../lib/types";
import { ChannelsEditor } from "../../components/ChannelsEditor";
import { ConfirmDialog } from "../../components/Confirm";
import { KeyValueEditor, fromPairs, toPairs, type KV } from "../../components/KeyValueEditor";
import { Badge, Button, Card, ErrorNote, Field, IconButton, Modal, Table, Toggle } from "../../components/ui";

interface RulesResponse {
  kinds: Record<string, string>;
  rules: AlertRule[];
}

type Draft = Omit<AlertRule, "id" | "params"> & { params: KV[] };

const EMPTY: Draft = { name: "", kind: "site_offline", site_id: null, params: [], severity: "warning", enabled: true, channels: [], cooldown_seconds: 900 };

export function RulesPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const { overview } = useHubData();
  const data = useLoad<RulesResponse>((signal) => api.get<RulesResponse>("/alerts/rules", signal));
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = can("alerts:manage");
  const kinds = data.data?.kinds ?? {};
  const siteName = (id: string | null) => (id ? overview?.sites.find((s) => s.id === id)?.name ?? id.slice(0, 8) : "all sites");

  async function toggle(rule: AlertRule, enabled: boolean) {
    try {
      await api.put(`/alerts/rules/${rule.id}`, { ...rule, enabled });
      data.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    const { draft, id } = editing;
    const body = { ...draft, params: fromPairs(draft.params), channels: draft.channels.filter((c) => c.chat_id.trim()) };
    try {
      if (id) await api.put(`/alerts/rules/${id}`, body);
      else await api.post("/alerts/rules", body);
      toast.success(id ? "Rule updated" : "Rule created");
      setEditing(null);
      data.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.del(`/alerts/rules/${deleting.id}`);
      toast.success("Rule deleted");
      data.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  return (
    <div className="stack">
      <Card title="Alert rules" actions={canManage && <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing({ id: null, draft: { ...EMPTY } })}>Add rule</Button>} flush>
        <ErrorNote error={data.error} />
        <Table
          caption="Alert rules"
          rowKey={(r) => r.id}
          rows={data.data?.rules ?? []}
          columns={[
            { key: "enabled", header: "On", render: (r) => <Toggle checked={r.enabled} disabled={!canManage} label={`Enable rule ${r.name}`} onChange={(v) => void toggle(r, v)} /> },
            { key: "name", header: "Rule", render: (r) => <div><div>{r.name}</div><div className="muted-dim">{kinds[r.kind] ?? r.kind}</div></div> },
            { key: "kind", header: "Kind", render: (r) => <span className="pill">{r.kind}</span> },
            { key: "sev", header: "Severity", render: (r) => <span className={`sev-${r.severity}`}>{r.severity}</span> },
            { key: "site", header: "Scope", render: (r) => siteName(r.site_id) },
            { key: "params", header: "Params", render: (r) => <span className="mono muted">{Object.keys(r.params ?? {}).length ? JSON.stringify(r.params) : "—"}</span> },
            { key: "channels", header: "Channels", render: (r) => (r.channels?.length ? r.channels.map((c) => `${c.platform}:${c.chat_id}`).join(", ") : <span className="faint">default</span>) },
            {
              key: "actions",
              header: "",
              render: (r) =>
                canManage && (
                  <span className="row" style={{ gap: 2 }}>
                    <IconButton label={`Edit rule ${r.name}`} icon={<Pencil size={13} />} onClick={() => setEditing({ id: r.id, draft: { ...r, params: toPairs(r.params ?? {}), channels: r.channels ?? [] } })} />
                    <IconButton label={`Delete rule ${r.name}`} icon={<Trash2 size={13} />} onClick={() => setDeleting(r)} />
                  </span>
                ),
            },
          ]}
        />
      </Card>

      <Card title="Rule kinds">
        <dl className="kv">
          {Object.entries(kinds).map(([k, d]) => (
            <div className="kv-row" key={k}>
              <dt className="mono">{k}</dt>
              <dd className="muted">{d}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {editing && (
        <RuleModal
          draft={editing.draft}
          kinds={kinds}
          sites={(overview?.sites ?? []).map((s) => ({ id: s.id, name: s.name }))}
          busy={busy}
          isNew={editing.id === null}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onClose={() => setEditing(null)}
          onSave={() => void save()}
        />
      )}
      <ConfirmDialog open={deleting !== null} title="Delete rule?" message={<>Delete <b>{deleting?.name}</b>? Open alerts from it stay until resolved.</>} danger confirmLabel="Delete" busy={busy} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />
    </div>
  );
}

function RuleModal({
  draft,
  kinds,
  sites,
  busy,
  isNew,
  onChange,
  onClose,
  onSave,
}: {
  draft: Draft;
  kinds: Record<string, string>;
  sites: { id: string; name: string }[];
  busy: boolean;
  isNew: boolean;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const [touched, setTouched] = useState(false);
  useEffect(() => setTouched(false), [isNew]);
  return (
    <Modal
      open
      title={isNew ? "New alert rule" : `Edit rule · ${draft.name}`}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={() => { setTouched(true); onSave(); }}>Save</Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Name">
            <input className="input" value={draft.name} onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
          <Field label="Kind">
            <select className="select" value={draft.kind} onChange={(e) => set("kind", e.target.value)}>
              {Object.keys(kinds).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
        </div>
        <div className="notice">{kinds[draft.kind] ?? "Unknown kind"}</div>
        <div className="grid-2">
          <Field label="Severity">
            <select className="select" value={draft.severity} onChange={(e) => set("severity", e.target.value as Draft["severity"])}>
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="critical">critical</option>
            </select>
          </Field>
          <Field label="Site scope">
            <select className="select" value={draft.site_id ?? ""} onChange={(e) => set("site_id", e.target.value || null)}>
              <option value="">All sites</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Cooldown (seconds)" hint="Flapping alerts within a third of this re-open quietly">
            <input className="input" type="number" min={0} max={86400} value={draft.cooldown_seconds} onChange={(e) => set("cooldown_seconds", Number(e.target.value))} />
          </Field>
          <Field label="Enabled">
            <span className="row"><Toggle checked={draft.enabled} onChange={(v) => set("enabled", v)} label="Rule enabled" /> {draft.enabled ? "on" : "off"}</span>
          </Field>
        </div>
        <Field label="Parameters">
          <KeyValueEditor value={draft.params} onChange={(v) => set("params", v)} hint="Numbers and true/false are converted automatically" />
        </Field>
        <Field label="Channels">
          <ChannelsEditor value={draft.channels as Channel[]} onChange={(v) => set("channels", v)} />
        </Field>
        {touched && !draft.name.trim() && <Badge status="error">Name is required</Badge>}
      </div>
    </Modal>
  );
}
