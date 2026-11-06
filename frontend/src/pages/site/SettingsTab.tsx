import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Link as LinkIcon, Trash2 } from "lucide-react";
import { api, errorMessage, qs } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useSite } from "../../lib/site";
import { usePolling } from "../../lib/usePolling";
import type { Site, SiteToken } from "../../lib/types";
import { ConfirmDialog } from "../../components/Confirm";
import { SecretOnce } from "../../components/SecretOnce";
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Table, Toggle } from "../../components/ui";
import { useHubData } from "../../lib/hubData";

export function SettingsTab() {
  const { site, ref, reload } = useSite();
  const { can } = useAuth();
  const hub = useHubData();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: site.name, url: site.url, description: site.description });
  const [newToken, setNewToken] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [revokeExisting, setRevokeExisting] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canEdit = can("sites:edit", site.id);
  const canTokens = can("sites:create", site.id);
  const canDelete = can("sites:delete", site.id);

  const tokens = usePolling<SiteToken[]>((signal) => (canTokens ? api.get<SiteToken[]>(`/sites/${ref}/tokens`, signal) : Promise.resolve([])), null, [ref, canTokens]);

  useEffect(() => {
    setForm({ name: site.name, url: site.url, description: site.description });
  }, [site.id, site.name, site.url, site.description]);

  async function patch(body: Partial<Site>, message: string) {
    setBusy("patch");
    try {
      await api.patch(`/sites/${ref}`, body);
      toast.success(message);
      reload();
      hub.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    setConfirmRotate(false);
    setBusy("rotate");
    try {
      const res = await api.post<{ agent_token: string }>(`/sites/${ref}/tokens${qs({ revoke_existing: revokeExisting })}`);
      setNewToken(res.agent_token);
      tokens.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function generateLinkCode() {
    setBusy("link");
    try {
      const res = await api.post<{ code: string }>("/me/bot-link-code");
      setLinkCode(res.code);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteSite() {
    setBusy("delete");
    try {
      await api.del(`/sites/${ref}${qs({ confirm: site.slug })}`);
      toast.success(`Deleted ${site.name}`);
      hub.refresh();
      navigate("/", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  const dirty = form.name !== site.name || form.url !== site.url || form.description !== site.description;

  return (
    <div className="stack">
      <div className="split">
        <Card title="Site details">
          <div className="stack">
            <Field label="Name">
              <input className="input" value={form.name} disabled={!canEdit} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="URL" hint="Optional link shown in the header (http:// or https://)">
              <input className="input" value={form.url} disabled={!canEdit} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://" />
            </Field>
            <Field label="Description">
              <textarea className="textarea" rows={3} style={{ fontFamily: "inherit" }} value={form.description} disabled={!canEdit} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </Field>
            <div className="row-between">
              <span className="muted-dim">Slug <code className="mono">{site.slug}</code> · id <code className="mono">{site.id}</code></span>
              {canEdit && (
                <Button variant="primary" size="sm" disabled={!dirty || !form.name.trim()} loading={busy === "patch"} onClick={() => void patch({ name: form.name.trim(), url: form.url.trim(), description: form.description }, "Site updated")}>
                  Save
                </Button>
              )}
            </div>
          </div>
        </Card>

        <Card title="Supervision">
          <div className="stack">
            <div className="row-between">
              <div>
                <div>Restart on crash</div>
                <div className="muted-dim">The agent restarts the script with backoff when it exits unexpectedly.</div>
              </div>
              <Toggle checked={site.crash_restart} disabled={!canEdit || busy === "patch"} label="Restart script on crash" onChange={(v) => void patch({ crash_restart: v }, v ? "Crash restart enabled" : "Crash restart disabled")} />
            </div>
            <div className="row-between">
              <div>
                <div>Bot account link</div>
                <div className="muted-dim">Generate a one-time code and send <code>/link CODE</code> to the Discord or Telegram bot.</div>
              </div>
              <Button size="sm" icon={<LinkIcon size={13} />} loading={busy === "link"} onClick={() => void generateLinkCode()}>Generate code</Button>
            </div>
            {linkCode && <SecretOnce label="Link code (valid 10 minutes)" value={linkCode} onDismiss={() => setLinkCode(null)} />}
          </div>
        </Card>
      </div>

      {canTokens && (
        <Card
          title="Agent tokens"
          subtitle="Used by bambou-agent to authenticate this site"
          actions={
            <span className="row">
              <label className="check"><input type="checkbox" checked={revokeExisting} onChange={(e) => setRevokeExisting(e.target.checked)} /> revoke existing</label>
              <Button size="sm" icon={<KeyRound size={13} />} loading={busy === "rotate"} onClick={() => setConfirmRotate(true)}>Rotate token</Button>
            </span>
          }
          flush
        >
          {newToken && <div className="card-body"><SecretOnce label="New agent token — copy it now, it won't be shown again" value={newToken} onDismiss={() => setNewToken(null)} /></div>}
          <ErrorNote error={tokens.error} />
          <Table
            dense
            caption="Agent tokens"
            rowKey={(t) => t.id}
            rows={tokens.data ?? []}
            columns={[
              { key: "label", header: "Label", render: (t) => t.label },
              { key: "id", header: "ID", mono: true, render: (t) => t.id.slice(0, 8) },
              { key: "created", header: "Created", render: (t) => fmtDate(t.created_at) },
              { key: "used", header: "Last used", render: (t) => fmtDate(t.last_used_at) },
              { key: "state", header: "State", render: (t) => (t.revoked_at ? <Badge status="stopped">revoked {fmtDate(t.revoked_at)}</Badge> : <Badge status="healthy">active</Badge>) },
            ]}
            empty={<EmptyState title="No tokens" />}
          />
        </Card>
      )}

      {canDelete && (
        <Card title="Danger zone" className="danger-zone">
          <div className="row-between">
            <div>
              <div>Delete this site</div>
              <div className="muted-dim">Removes the site and all of its logs, metrics, costs, files and backups records. This cannot be undone.</div>
            </div>
            <Button variant="danger" icon={<Trash2 size={13} />} onClick={() => setConfirmDelete(true)}>Delete site</Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmRotate}
        title="Rotate agent token?"
        message={revokeExisting ? "All existing tokens will be revoked. The agent will disconnect until you install the new token." : "A new token is issued; existing tokens keep working."}
        confirmLabel="Rotate"
        danger={revokeExisting}
        onClose={() => setConfirmRotate(false)}
        onConfirm={() => void rotate()}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${site.name}?`}
        message="All telemetry and configuration for this site will be permanently deleted."
        requireText={site.slug}
        confirmLabel="Delete permanently"
        danger
        busy={busy === "delete"}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void deleteSite()}
      />
    </div>
  );
}
