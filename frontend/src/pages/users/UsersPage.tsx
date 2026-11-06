import { useState } from "react";
import { Pencil, Plus, ShieldOff } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, fmtAgo } from "../../lib/format";
import { useHubData } from "../../lib/hubData";
import { useLoad } from "../../lib/usePolling";
import type { Catalog, User } from "../../lib/types";
import { Badge, Button, Card, EmptyState, ErrorNote, IconButton, Tabs, Table, type Column } from "../../components/ui";
import { UserModal } from "./UserModal";
import { BotsPanel } from "./BotsPanel";

export function UsersPage() {
  const { can } = useAuth();
  const [view, setView] = useState("users");
  if (!can("users:manage") && !can("bots:manage")) {
    return <Card title="Users"><EmptyState icon={<ShieldOff size={20} />} title="No access" hint="You need users:manage or bots:manage." /></Card>;
  }
  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="page-title">Users & bots</h1>
          <p className="page-sub">Dashboard accounts, permissions, and chat bot links</p>
        </div>
      </div>
      <Tabs
        tabs={[
          ...(can("users:manage") ? [{ id: "users", label: "Users" }] : []),
          { id: "bots", label: "Bots" },
        ]}
        active={view}
        onChange={setView}
      />
      {view === "users" && can("users:manage") && <UsersPanel />}
      {view === "bots" && <BotsPanel />}
    </div>
  );
}

function UsersPanel() {
  const { user: me } = useAuth();
  const hub = useHubData();
  const users = useLoad<User[]>((signal) => api.get<User[]>("/users", signal));
  const catalog = useLoad<Catalog>((signal) => api.get<Catalog>("/auth/catalog", signal));
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const sites = (hub.overview?.sites ?? []).map((s) => ({ id: s.id, name: s.name }));
  const siteLabel = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  const columns: Column<User>[] = [
    { key: "user", header: "User", render: (u) => <div><div>{u.username}{u.id === me?.id && <span className="faint"> (you)</span>}</div><div className="muted-dim">{u.display_name || "—"}</div></div> },
    { key: "role", header: "Role", render: (u) => <span className="pill">{u.role}</span> },
    { key: "extra", header: "Extra permissions", render: (u) => (u.extra_permissions.length ? <span className="mono muted">{u.extra_permissions.join(", ")}</span> : <span className="faint">—</span>) },
    { key: "scope", header: "Site scope", render: (u) => (u.site_scope ? u.site_scope.map(siteLabel).join(", ") : <span className="muted">all sites</span>) },
    { key: "disabled", header: "State", render: (u) => (u.disabled ? <Badge status="stopped">disabled</Badge> : <Badge status="healthy">active</Badge>) },
    { key: "login", header: "Last login", render: (u) => <span className="nowrap" title={fmtDate(u.last_login_at)}>{u.last_login_at ? fmtAgo(u.last_login_at) : "never"}</span> },
    { key: "actions", header: "", render: (u) => <IconButton label={`Edit user ${u.username}`} icon={<Pencil size={13} />} onClick={() => setEditing(u)} /> },
  ];

  return (
    <div className="stack">
      <ErrorNote error={users.error} />
      <Card
        title={`${users.data?.length ?? 0} user(s)`}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing("new")}>New user</Button>}
        flush
      >
        <Table caption="Users" rowKey={(u) => u.id} rows={users.data ?? []} columns={columns} onRowClick={setEditing} />
      </Card>
      <Card title="Permission reference">
        <dl className="kv">
          {Object.entries(catalog.data?.permissions ?? {}).map(([perm, desc]) => (
            <div className="kv-row" key={perm}>
              <dt className="mono">{perm}</dt>
              <dd className="muted">{desc}</dd>
            </div>
          ))}
        </dl>
        <div className="row" style={{ marginTop: 10, gap: 14 }}>
          {Object.entries(catalog.data?.roles ?? {}).map(([role, perms]) => (
            <span key={role} className="muted-dim"><b className="pill">{role}</b> {perms.length} permissions</span>
          ))}
        </div>
      </Card>
      {editing && catalog.data && (
        <UserModal
          user={editing === "new" ? null : editing}
          catalog={catalog.data}
          sites={sites}
          isSelf={editing !== "new" && editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={() => { users.refresh(); setEditing(null); }}
        />
      )}
    </div>
  );
}
