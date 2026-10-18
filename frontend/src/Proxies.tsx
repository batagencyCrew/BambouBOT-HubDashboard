import { useState, type FormEvent } from "react";
import {
  Globe2,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api, errorMessage, json } from "./api";
import type { Proxy } from "./types";
import { Confirm, dateTime, Empty, ErrorBanner, Modal } from "./ui";

export default function Proxies({
  siteId,
  proxies,
  onChange,
}: {
  siteId: string;
  proxies: Proxy[];
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<Proxy | null>(null);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function closeAdd() {
    if (!busy) {
      setAdding(false);
      setUrl("");
      setUsername("");
      setPassword("");
      setError("");
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const parsed = new URL(url);
      if (
        !["http:", "https:", "socks5:"].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
      )
        throw new Error(
          "Use an HTTP, HTTPS, or SOCKS5 URL without embedded credentials. Enter credentials in the separate fields.",
        );
      setBusy(true);
      await api<Proxy>(
        `/sites/${siteId}/proxies`,
        json("POST", {
          url: url.trim(),
          ...(username ? { username } : {}),
          ...(password ? { password } : {}),
        }),
      );
      setAdding(false);
      setUrl("");
      setUsername("");
      setPassword("");
      onChange();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function removeProxy() {
    if (!remove) return;
    setBusy(true);
    setError("");
    try {
      await api<void>(`/sites/${siteId}/proxies/${remove.id}`, json("DELETE"));
      setRemove(null);
      onChange();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-heading inner-heading">
        <div>
          <h2>
            Proxy pool <span className="count">{proxies.length}</span>
          </h2>
          <p>Connection routes available to this site’s agent.</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setError("");
            setAdding(true);
          }}
        >
          <Plus size={16} />
          Add proxy
        </button>
      </div>
      <div className="panel">
        {proxies.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Proxy URL</th>
                  <th>Username</th>
                  <th>Credentials</th>
                  <th>Added</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((proxy) => (
                  <tr key={proxy.id}>
                    <td>
                      <span className="proxy-url">
                        <Globe2 size={17} />
                        {proxy.url}
                      </span>
                    </td>
                    <td>
                      {proxy.username || <span className="muted">None</span>}
                    </td>
                    <td>
                      <span className="credential-label">
                        <KeyRound size={14} />
                        {proxy.has_password
                          ? "Password configured"
                          : "No password"}
                      </span>
                    </td>
                    <td className="time-cell">{dateTime(proxy.created_at)}</td>
                    <td>
                      <button
                        className="icon-button danger-text"
                        aria-label={`Remove proxy ${proxy.url}`}
                        onClick={() => {
                          setRemove(proxy);
                          setError("");
                        }}
                      >
                        <Trash2 size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No proxies configured">
            Add a proxy to make it available to this site’s agent.
          </Empty>
        )}
        <div className="panel-footnote">
          <span>
            <ShieldCheck size={14} />
            Proxy passwords are write-only
          </span>
          <span>HTTP · HTTPS · SOCKS5 · Restart workers after changes</span>
        </div>
      </div>
      {adding && (
        <Modal
          title="Add a proxy"
          subtitle="Credentials are stored separately from the proxy URL."
          onClose={closeAdd}
        >
          <form onSubmit={(event) => void add(event)}>
            <div className="modal-body">
              {error && <ErrorBanner message={error} />}
              <label className="field">
                Proxy URL
                <input
                  autoFocus
                  type="url"
                  required
                  value={url}
                  maxLength={2048}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="socks5://proxy.example.com:1080"
                />
                <span className="field-hint">
                  HTTP, HTTPS, or SOCKS5. No credentials in the URL.
                </span>
              </label>
              <label className="field">
                Username <span className="optional">Optional</span>
                <input
                  value={username}
                  maxLength={256}
                  autoComplete="off"
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label className="field">
                Password <span className="optional">Optional</span>
                <input
                  type="password"
                  value={password}
                  maxLength={1024}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button
                className="button"
                type="button"
                onClick={closeAdd}
                disabled={busy}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Plus size={16} />
                )}
                Add proxy
              </button>
            </div>
          </form>
        </Modal>
      )}
      {remove && (
        <Confirm
          title="Remove proxy?"
          label="Remove proxy"
          busy={busy}
          error={error}
          onConfirm={() => void removeProxy()}
          onClose={() => setRemove(null)}
        >
          Remove <strong>{remove.url}</strong> from this site? It will no longer
          be included when the agent next refreshes its configuration.
        </Confirm>
      )}
    </>
  );
}
