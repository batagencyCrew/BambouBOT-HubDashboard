import { useState } from "react";
import { Bot, Link2, Plus, Trash2 } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate } from "../../lib/format";
import { useToast } from "../../lib/toast";
import { useLoad, usePolling } from "../../lib/usePolling";
import type { BotLink, ServiceToken } from "../../lib/types";
import { ConfirmDialog } from "../../components/Confirm";
import { SecretOnce } from "../../components/SecretOnce";
import { Badge, Button, Card, EmptyState, ErrorNote, IconButton, Table } from "../../components/ui";

export function BotsPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const canBots = can("bots:manage");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ServiceToken | null>(null);
  const [unlink, setUnlink] = useState<BotLink | null>(null);
  const [busy, setBusy] = useState(false);

  const links = usePolling<BotLink[]>((signal) => (canBots ? api.get<BotLink[]>("/bot-links", signal) : Promise.resolve([])), 30_000, [canBots]);
  const tokens = usePolling<ServiceToken[]>((signal) => (canBots ? api.get<ServiceToken[]>("/service-tokens", signal) : Promise.resolve([])), 30_000, [canBots]);
  const myLinks = useLoad<BotLink[]>((signal) => api.get<BotLink[]>("/me/bot-links", signal));

  async function createToken() {
    setBusy(true);
    try {
      const res = await api.post<{ id: string; token: string }>("/service-tokens/bot");
      setNewToken(res.token);
      tokens.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken() {
    if (!revoke) return;
    setBusy(true);
    try {
      await api.del(`/service-tokens/${revoke.id}`);
      toast.success("Token revoked");
      tokens.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setRevoke(null);
    }
  }

  async function unlinkMine() {
    if (!unlink) return;
    setBusy(true);
    try {
      await api.del(`/me/bot-links/${unlink.platform}/${encodeURIComponent(unlink.platform_user)}`);
      toast.success("Bot account unlinked");
      myLinks.refresh();
      links.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setUnlink(null);
    }
  }

  async function makeCode() {
    setBusy(true);
    try {
      const res = await api.post<{ code: string }>("/me/bot-link-code");
      setLinkCode(res.code);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="split">
        <Card
          title="Your bot account"
          subtitle="Link your Discord or Telegram account to act as yourself through the bot"
          actions={
            <>
              <Button size="sm" icon={<Link2 size={13} />} loading={busy} onClick={() => void makeCode()}>Link code</Button>
              {!canBots && <Button size="sm" variant="primary" icon={<Plus size={13} />} loading={busy} onClick={() => void createToken()}>Generate bot token</Button>}
            </>
          }
        >
          {linkCode && <div style={{ marginBottom: 10 }}><SecretOnce label="Send this to the bot: /link CODE (valid 10 minutes)" value={linkCode} onDismiss={() => setLinkCode(null)} /></div>}
          <ErrorNote error={myLinks.error} />
          <Table
            dense
            caption="Your bot links"
            rowKey={(l) => `${l.platform}-${l.platform_user}`}
            rows={myLinks.data ?? []}
            columns={[
              { key: "platform", header: "Platform", render: (l) => <span className="pill">{l.platform}</span> },
              { key: "user", header: "Account", render: (l) => <span className="mono">{l.platform_user}</span> },
              { key: "since", header: "Linked", render: (l) => fmtDate(l.created_at) },
              { key: "actions", header: "", render: (l) => <IconButton label={`Unlink ${l.platform} account`} icon={<Trash2 size={13} />} onClick={() => setUnlink(l)} /> },
            ]}
            empty={<EmptyState icon={<Bot size={20} />} title="No linked bot accounts" hint="Generate a code and send /link <code> to the bot." />}
          />
        </Card>

        {canBots && (
          <Card title="Bot service tokens" subtitle="Used by the BambouBot process (Authorization: Bearer hbt_…)" actions={<Button size="sm" icon={<Plus size={13} />} loading={busy} onClick={() => void createToken()}>Generate token</Button>}>
            {newToken && <div style={{ marginBottom: 10 }}><SecretOnce label="New bot token — shown once" value={newToken} onDismiss={() => setNewToken(null)} /></div>}
            <ErrorNote error={tokens.error} />
            <Table
              dense
              caption="Service tokens"
              rowKey={(t) => t.id}
              rows={tokens.data ?? []}
              columns={[
                { key: "label", header: "Label", render: (t) => t.label },
                { key: "created", header: "Created", render: (t) => fmtDate(t.created_at) },
                { key: "used", header: "Last used", render: (t) => fmtDate(t.last_used_at) },
                { key: "state", header: "State", render: (t) => (t.revoked_at ? <Badge status="stopped">revoked</Badge> : <Badge status="healthy">active</Badge>) },
                { key: "actions", header: "", render: (t) => !t.revoked_at && <IconButton label="Revoke token" icon={<Trash2 size={13} />} onClick={() => setRevoke(t)} /> },
              ]}
              empty={<EmptyState title="No service tokens" />}
            />
          </Card>
        )}
      </div>

      {canBots && (
        <Card title="All bot links" flush>
          <ErrorNote error={links.error} />
          <Table
            dense
            caption="All bot links"
            rowKey={(l) => `${l.platform}-${l.platform_user}`}
            rows={links.data ?? []}
            columns={[
              { key: "platform", header: "Platform", render: (l) => <span className="pill">{l.platform}</span> },
              { key: "account", header: "Chat account", render: (l) => <span className="mono">{l.platform_user}</span> },
              { key: "user", header: "Hub user", render: (l) => l.username ?? "—" },
              { key: "since", header: "Linked", render: (l) => fmtDate(l.created_at) },
            ]}
            empty={<EmptyState title="No bot links" />}
          />
        </Card>
      )}

      <ConfirmDialog open={revoke !== null} title="Revoke service token?" message="The bot will lose API access immediately." danger confirmLabel="Revoke" busy={busy} onClose={() => setRevoke(null)} onConfirm={() => void revokeToken()} />
      <ConfirmDialog open={unlink !== null} title="Unlink bot account?" message={<>Unlink <b>{unlink?.platform}:{unlink?.platform_user}</b> from your hub account?</>} danger confirmLabel="Unlink" busy={busy} onClose={() => setUnlink(null)} onConfirm={() => void unlinkMine()} />
    </div>
  );
}
