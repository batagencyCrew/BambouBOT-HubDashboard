import { useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useToast } from "../../lib/toast";
import type { Catalog, User } from "../../lib/types";
import { Button, Card, ErrorNote, Field, Modal } from "../../components/ui";

const ROLE_ORDER = ["owner", "admin", "operator", "viewer"];

export function UserModal({
  user,
  catalog,
  sites,
  isSelf,
  onClose,
  onSaved,
}: {
  user: User | null;
  catalog: Catalog;
  sites: { id: string; name: string }[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user: me } = useAuth();
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [role, setRole] = useState(user?.role ?? "viewer");
  const [extra, setExtra] = useState<string[]>(user?.extra_permissions ?? []);
  const [allSites, setAllSites] = useState(user ? user.site_scope === null : true);
  const [scope, setScope] = useState<string[]>(user?.site_scope ?? []);
  const [password, setPassword] = useState("");
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = me?.role === "owner";
  const groups = Object.entries(catalog.permissions).reduce<Record<string, [string, string][]>>((acc, [perm, desc]) => {
    const group = perm.split(":")[0];
    (acc[group] ??= []).push([perm, desc]);
    return acc;
  }, {});
  const roleDefaults = new Set(catalog.roles[role] ?? []);
  const togglePerm = (perm: string) => setExtra((p) => (p.includes(perm) ? p.filter((x) => x !== perm) : [...p, perm]));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (user) {
        const body: Record<string, unknown> = {
          display_name: displayName,
          extra_permissions: extra,
          site_scope: allSites ? null : scope,
          clear_site_scope: allSites,
          disabled,
        };
        if (!isSelf) body.role = role;
        if (password) body.password = password;
        await api.patch(`/users/${user.id}`, body);
        toast.success("User updated");
      } else {
        await api.post("/users", {
          username: username.trim(),
          display_name: displayName,
          password,
          role,
          extra_permissions: extra,
          site_scope: allSites ? null : scope,
        });
        toast.success("User created");
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const passwordOk = password === "" ? !!user : password.length >= 12;

  return (
    <Modal
      open
      title={user ? `Edit ${user.username}` : "New user"}
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!passwordOk || (!user && (!username.trim() || !password))} onClick={() => void submit()}>
            {user ? "Save changes" : "Create user"}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorNote error={error} />
        <div className="grid-2">
          <Field label="Username">
            <input className="input mono" value={username} disabled={!!user} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Display name">
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Role" hint={isSelf ? "You cannot change your own role" : "Role defaults are combined with extra permissions"}>
            <select className="select" value={role} disabled={!!user && isSelf} onChange={(e) => setRole(e.target.value)}>
              {ROLE_ORDER.filter((r) => r !== "owner" || isOwner).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label={user ? "Reset password" : "Password"} hint="At least 12 characters">
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={user ? "leave blank to keep" : ""} />
          </Field>
        </div>

        <Card title="Extra permissions" subtitle={`Granted on top of the ${role} role`} flush>
          <div className="card-body stack" style={{ gap: 10 }}>
            {Object.entries(groups).map(([group, perms]) => (
              <div key={group}>
                <div className="field-label" style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>{group}</div>
                <div className="row" style={{ gap: 12 }}>
                  {perms.map(([perm, desc]) => (
                    <label key={perm} className="check" title={desc}>
                      <input type="checkbox" checked={roleDefaults.has(perm) || extra.includes(perm)} disabled={roleDefaults.has(perm)} onChange={() => togglePerm(perm)} />
                      {perm.split(":")[1]}
                      {roleDefaults.has(perm) && <span className="faint">(role)</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Site scope" flush>
          <div className="card-body stack">
            <label className="check">
              <input type="checkbox" checked={allSites} onChange={(e) => setAllSites(e.target.checked)} /> All sites
            </label>
            {!allSites && (
              <div className="row" style={{ gap: 12 }}>
                {sites.length === 0 && <span className="muted-dim">No sites</span>}
                {sites.map((s) => (
                  <label key={s.id} className="check">
                    <input type="checkbox" checked={scope.includes(s.id)} onChange={(e) => setScope((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </Card>

        {user && (
          <label className="check">
            <input type="checkbox" checked={disabled} disabled={isSelf} onChange={(e) => setDisabled(e.target.checked)} /> Disabled (sessions are revoked immediately)
          </label>
        )}
      </div>
    </Modal>
  );
}
