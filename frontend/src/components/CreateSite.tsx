import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Field, Modal } from "./ui";
import { SecretOnce } from "./SecretOnce";

interface Created {
  site: { id: string; slug: string; name: string };
  agent_token: string;
}

/** "Add site" button + modal. Shows the agent token exactly once. */
export function CreateSiteButton({ onCreated }: { onCreated?: () => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", url: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Created | null>(null);

  if (!can("sites:create")) return null;

  const close = () => {
    setOpen(false);
    setForm({ name: "", url: "", description: "" });
    setError("");
    if (created) navigate(`/sites/${created.site.slug}/settings`);
    setCreated(null);
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.post<Created>("/sites", form);
      setCreated(result);
      onCreated?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="primary" icon={<Plus size={14} />} onClick={() => setOpen(true)}>Add site</Button>
      <Modal
        open={open}
        title={created ? `Site ${created.site.name} created` : "Add site"}
        onClose={close}
        footer={created ? <Button variant="primary" onClick={close}>Done</Button> : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!form.name.trim()} onClick={submit}>Create</Button>
          </>
        )}
      >
        {created ? (
          <div className="stack">
            <SecretOnce label="Agent token — copy it now; it is not shown again. Put it in the VPS agent config as HUB_AGENT_TOKEN." value={created.agent_token} onDismiss={close} />
            <p className="muted">Next: install bambou-agent on the VPS (docs/v2/INTEGRATION.md) and point it at this hub.</p>
          </div>
        ) : (
          <div className="stack">
            <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="alpha" /></Field>
            <Field label="URL" hint="Optional (http:// or https://)"><input className="input" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://" /></Field>
            <Field label="Description"><textarea className="textarea" rows={3} style={{ fontFamily: "inherit" }} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></Field>
            {error && <div className="error-note">{error}</div>}
          </div>
        )}
      </Modal>
    </>
  );
}
