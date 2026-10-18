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
import ProxyImport, { type ProxyType } from "./ProxyImport";

function proxyAddress(type: ProxyType, value: string) {
  const hostPort = value.trim();
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):(\d+)$/.exec(hostPort);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("Enter only a hostname/IP and port (1–65535). Bracket IPv6 addresses, e.g. [2001:db8::1]:1080. Do not include a protocol, path, or credentials.");
  const host = match[1];
  if (!host.startsWith("[") && !host.replace(/\.$/, "").split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
    throw new Error("Enter a valid hostname or IP address.");
  try {
    // HTTP's URL parser validates bracketed IPv6 and numeric IPv4 as well.
    const parsed = new URL(`http://${host}:${Number(match[2])}`);
    return `${type}://${parsed.hostname}:${Number(match[2])}`;
  } catch {
    throw new Error("Enter a valid hostname or IP address. IPv6 must be bracketed.");
  }
}

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
  const [hostPort, setHostPort] = useState("");
  const [proxyType, setProxyType] = useState<ProxyType>("http");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function closeAdd() {
    if (!busy) {
      setAdding(false);
      setHostPort("");
      setProxyType("http");
      setUsername("");
      setPassword("");
      setError("");
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const url = proxyAddress(proxyType, hostPort);
      setBusy(true);
      await api<Proxy>(
        `/sites/${siteId}/proxies`,
        json("POST", {
          url,
          ...(username ? { username } : {}),
          ...(password ? { password } : {}),
        }),
      );
      setAdding(false);
      setHostPort("");
      setProxyType("http");
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
        <div className="proxy-actions">
        <button className="button" onClick={() => setImporting(true)}>
          Import proxies
        </button>
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
      </div>
      {notice && <div className="notice" role="status">{notice}</div>}
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
                Proxy type
                <select aria-label="Proxy type" value={proxyType} disabled={busy}
                  onChange={(event) => { setProxyType(event.target.value as ProxyType); setError(""); }}>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </label>
              <label className="field">
                Host:port
                <input
                  autoFocus
                  aria-label="Host:port"
                  type="text"
                  required
                  value={hostPort}
                  disabled={busy}
                  maxLength={2048}
                  onChange={(event) => { setHostPort(event.target.value); setError(""); }}
                  placeholder="proxy.example.com:1080"
                />
                <span className="field-hint">
                  Hostname/IP and explicit port only. Bracket IPv6: [2001:db8::1]:1080.
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
      {importing && <ProxyImport siteId={siteId} onClose={() => setImporting(false)}
        onImported={(result) => {
          setNotice(`Imported ${result.imported} proxies; ${result.duplicates} duplicates skipped. Restart workers to use the updated pool.`);
          setImporting(false);
          onChange();
        }} />}
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
