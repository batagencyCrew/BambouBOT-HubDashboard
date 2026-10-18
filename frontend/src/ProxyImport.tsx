import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { api, json } from "./api";
import { ErrorBanner, Modal } from "./ui";

export type ProxyType = "http" | "https" | "socks5";
type ImportResult = {
  total: number;
  valid: number;
  duplicates: number;
  imported: number;
  can_import: boolean;
  errors: { line: number; message: string }[];
  entries: { line: number; url: string; username: string; has_password: boolean; duplicate: boolean }[];
};

// Never render embedded credentials, even if a server returns a malformed URL.
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "socks5:"].includes(url.protocol)) return "Invalid proxy URL";
    // URL.port omits default ports; preserve the explicit host:port display.
    const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0];
    const port = /:(\d+)$/.exec(authority)?.[1] || url.port;
    return `${url.protocol}//${url.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return "Invalid proxy URL";
  }
}

export default function ProxyImport({ siteId, onClose, onImported }: {
  siteId: string;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [proxyType, setProxyType] = useState<ProxyType>("http");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState<"file" | "preview" | "import" | null>(null);
  const generation = useRef(0);
  const previewGeneration = useRef(-1);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { generation.current++; }, []);

  function invalidate() {
    generation.current++;
    previewGeneration.current = -1;
    setPreview(null);
    setError("");
    setLoading(null);
  }
  function clear() {
    invalidate();
    setContent(null);
    if (fileInput.current) fileInput.current.value = "";
  }
  function close() {
    if (loading === "import") return;
    clear();
    onClose();
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    invalidate();
    setContent(null);
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      setError("Proxy files must be no larger than 512 KiB.");
      return;
    }
    if (!/\.(txt|list)$/i.test(file.name)) {
      setError("Choose a .txt or .list proxy file.");
      return;
    }
    const version = generation.current;
    setLoading("file");
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (version === generation.current) setContent(text);
    } catch {
      if (version === generation.current) setError("Unable to read the file. Choose a UTF-8 text file.");
    } finally {
      if (version === generation.current) setLoading(null);
    }
  }
  const canImport = !!preview && preview.can_import && preview.valid > 0 &&
    preview.errors.length === 0 && previewGeneration.current === generation.current;

  async function request(dryRun: boolean) {
    if (content === null || loading || (!dryRun && !canImport)) return;
    const version = ++generation.current;
    previewGeneration.current = -1;
    setPreview(null);
    setError("");
    setLoading(dryRun ? "preview" : "import");
    try {
      const result = await api<ImportResult>(`/sites/${siteId}/proxies/import`,
        json("POST", { content, proxy_type: proxyType, dry_run: dryRun }));
      if (version !== generation.current) return;
      if (!dryRun && result.errors.length === 0) {
        clear();
        onImported(result);
        return;
      }
      setPreview(result);
      // A failed commit requires a fresh preview before another attempt.
      if (dryRun) previewGeneration.current = version;
    } catch {
      if (version === generation.current)
        setError(dryRun ? "Could not preview proxies. Please try again." :
          "Import could not be confirmed. Preview again to check the pool before retrying.");
    } finally {
      if (version === generation.current) setLoading(null);
    }
  }

  return (
    <Modal title="Import proxies" subtitle="Preview a UTF-8 proxy file before importing. Passwords are never shown." onClose={close}>
      <div className="modal-body">
        {error && <ErrorBanner message={error} />}
        <label className="field">
          Proxy file
          <input ref={fileInput} type="file" aria-label="Proxy file" accept=".txt,.list,text/plain"
            disabled={loading === "import"} onChange={(event) => void readFile(event)} />
           <span className="field-hint">.txt or .list, up to 512 KiB and 1,000 entries. Blank lines and # comments are ignored.</span>
           <span className="field-hint">One proxy per line: host:port, host:port:username:password, or a full proxy URL.</span>
        </label>
        <label className="field">
          Default proxy type
          <select aria-label="Default proxy type" value={proxyType} disabled={loading === "file" || loading === "import"}
            onChange={(event) => { invalidate(); setProxyType(event.target.value as ProxyType); }}>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
            <option value="socks5">SOCKS5</option>
          </select>
          <span className="field-hint">Used only for lines without an explicit protocol. Invalid lines reject the entire import.</span>
        </label>
        {loading && <p role="status"><LoaderCircle className="spin" size={16} /> {loading === "file" ? "Reading file…" : loading === "preview" ? "Previewing…" : "Importing…"}</p>}
        {preview && <div className="proxy-import-preview">
          <p role="status">Total: {preview.total} · New valid: {preview.valid} · Duplicates: {preview.duplicates} · Errors: {preview.errors.length}</p>
          {preview.errors.length > 0 && <div role="alert">
            <p>Nothing imported. Fix the errors and preview the file again.</p>
            <ul>{preview.errors.map((item, index) => <li key={index}>
              {item.line > 0 ? `Line ${item.line}` : "File"}: {item.message}
            </li>)}</ul>
          </div>}
          {!preview.errors.length && !preview.valid && <p>No new proxies to import.</p>}
          {preview.entries.length > 0 && <div className="table-scroll">
            <table>
              <thead><tr><th>Line</th><th>Proxy URL</th><th>Username</th><th>Password</th><th>Status</th></tr></thead>
              <tbody>{preview.entries.map((entry) => <tr key={entry.line}>
                <td>{entry.line}</td><td>{safeUrl(entry.url)}</td><td>{entry.username || "None"}</td>
                <td>{entry.has_password ? "Configured" : "None"}</td><td>{entry.duplicate ? "Duplicate" : "New"}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </div>}
      </div>
      <div className="modal-footer proxy-import-footer">
        <button className="button" onClick={close} disabled={loading === "import"}>Cancel</button>
        <button className="button" onClick={() => void request(true)} disabled={content === null || !!loading}>Preview import</button>
        <button className="button primary" onClick={() => void request(false)} disabled={!canImport || !!loading}>Import proxies</button>
      </div>
    </Modal>
  );
}
