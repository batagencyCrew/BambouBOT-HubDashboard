import { useCallback, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Bot,
  CloudUpload,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  Globe2,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  RotateCw,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { api, errorMessage, json } from "./api";
import type {
  Action,
  Command,
  Config,
  HubError,
  Proxy,
  Site,
  SiteData,
  Worker,
} from "./types";
import {
  Badge,
  Confirm,
  dateTime,
  ErrorBanner,
  externalUrl,
  Loading,
  Modal,
  relativeTime,
  TokenModal,
} from "./ui";
import { usePolling } from "./usePolling";
import { Commands, ErrorList, Workers } from "./components";
import Configuration from "./Configuration";
import Proxies from "./Proxies";
import Backups from "./Backups";
import Stats from "./Stats";

const tabs = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "statistics", label: "Statistics", icon: BarChart3 },
  { id: "workers", label: "Workers", icon: Bot },
  { id: "logs", label: "Logs", icon: FileText },
  { id: "configuration", label: "Configuration", icon: Settings2 },
  { id: "proxies", label: "Proxies", icon: Network },
  { id: "backups", label: "Backups", icon: CloudUpload },
] as const;
type Tab = (typeof tabs)[number]["id"];

function EditSite({
  site,
  onClose,
  onSaved,
}: {
  site: Site;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(site.name);
  const [url, setUrl] = useState(site.url);
  const [description, setDescription] = useState(site.description || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (!name.trim()) throw new Error("A site name is required.");
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error(
          "Use an HTTP or HTTPS URL without embedded credentials.",
        );
      setBusy(true);
      await api<Site>(
        `/sites/${site.id}`,
        json("PATCH", {
          name: name.trim(),
          url: url.trim(),
          description: description.trim(),
        }),
      );
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Edit site details"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="modal-body">
          {error && <ErrorBanner message={error} />}
          <label className="field">
            Site name
            <input
              autoFocus
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="field">
            Site URL
            <input
              required
              type="url"
              maxLength={2048}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="field">
            Description
            <textarea
              maxLength={2000}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={16} />}Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function SiteDetail({
  id,
  onDeleted,
  onChange,
}: {
  id: string;
  onDeleted: () => void;
  onChange: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [confirm, setConfirm] = useState<
    "rotate" | "delete" | "stop" | "restart" | null
  >(null);
  const [edit, setEdit] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitted, setSubmitted] = useState<Command[]>([]);
  const load = useCallback(async (): Promise<SiteData> => {
    const [site, workers, errors, config, proxies, commands] =
      await Promise.all([
        api<Site>(`/sites/${id}`),
        api<Worker[]>(`/sites/${id}/workers`),
        api<HubError[]>(`/sites/${id}/errors?limit=100`),
        api<Config>(`/sites/${id}/config`),
        api<Proxy[]>(`/sites/${id}/proxies`),
        api<Command[]>(`/sites/${id}/commands`),
      ]);
    return { site, workers, errors, config, proxies, commands };
  }, [id]);
  const { data, error, refreshing, refresh, updatedAt } = usePolling(load);
  const changed = () => {
    void refresh();
    onChange();
  };
  const commands = data
    ? [
        ...submitted.filter(
          (command) => !data.commands.some((item) => item.id === command.id),
        ),
        ...data.commands,
      ]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 20)
    : [];

  async function dispatch(action: Action) {
    setActionBusy(true);
    setActionError("");
    setNotice("");
    try {
      const command = await api<Command>(
        `/sites/${id}/commands`,
        json("POST", { action }),
      );
      setSubmitted((current) => [command, ...current].slice(0, 20));
      setNotice(
        `${action[0].toUpperCase() + action.slice(1)} command dispatched (${command.status}). Worker state updates only after the agent reports it.`,
      );
      setConfirm(null);
      changed();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }
  async function confirmAction() {
    if (confirm === "stop" || confirm === "restart") {
      await dispatch(confirm);
      return;
    }
    setActionBusy(true);
    setActionError("");
    try {
      if (confirm === "rotate") {
        const result = await api<{ agent_token: string }>(
          `/sites/${id}/agent-token`,
          json("POST"),
        );
        setConfirm(null);
        setToken(result.agent_token);
      } else if (confirm === "delete") {
        await api<void>(`/sites/${id}`, json("DELETE"));
        onDeleted();
      }
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }
  function openConfirm(value: typeof confirm) {
    setActionError("");
    setConfirm(value);
  }
  if (!data)
    return (
      <>
        {error ? (
          <ErrorBanner message={error} retry={() => void refresh()} />
        ) : (
          <Loading label="Loading site operations…" />
        )}
      </>
    );
  const { site, workers, config, proxies, errors } = data;
  const running = workers.filter(
    (worker) => worker.status === "running",
  ).length;
  const totalTasks = workers.reduce(
    (sum, worker) => sum + worker.tasks_completed,
    0,
  );
  const href = externalUrl(site.url);
  return (
    <>
      <div className="page-heading detail-heading">
        <div>
          <div className="eyebrow">SITE OPERATIONS</div>
          <div className="detail-title">
            <span className={`site-avatar ${site.status}`}>
              <Globe2 size={25} />
            </span>
            <h1>{site.name}</h1>
            <Badge value={site.status} />
          </div>
          <p className="detail-url">
            {href ? (
              <a href={href} target="_blank" rel="noreferrer">
                {site.url}
                <ExternalLink size={13} />
              </a>
            ) : (
              site.url
            )}
          </p>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={() => setEdit(true)}>
            <Pencil size={15} />
            Edit site
          </button>
          <button
            className="icon-button refresh-button"
            aria-label="Refresh site"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
          </button>
        </div>
      </div>
      {error && (
        <ErrorBanner
          message={`Data may be out of date. ${error}`}
          retry={() => void refresh()}
        />
      )}
      <div className="site-control-bar">
        <div>
          <span className="live-label">
            <Radio size={15} />
            Last heartbeat{" "}
            <strong title={dateTime(site.last_seen)}>
              {relativeTime(site.last_seen)}
            </strong>
          </span>
          <span className="desired-state">
            Desired state <Badge value={site.desired_state} />
          </span>
        </div>
        <div className="worker-actions" aria-label="Worker lifecycle controls">
          <button
            className="button primary small"
            disabled={actionBusy}
            onClick={() => void dispatch("start")}
          >
            <Play size={14} />
            Start
          </button>
          <button
            className="button small"
            disabled={actionBusy}
            onClick={() => openConfirm("stop")}
          >
            <Square size={13} />
            Stop
          </button>
          <button
            className="button small"
            disabled={actionBusy}
            onClick={() => openConfirm("restart")}
          >
            <RotateCw size={14} />
            Restart
          </button>
        </div>
      </div>
      <div className="control-note">
        <Clock3 size={13} />
        Actions are queued for the agent. Reported worker state is not changed
        optimistically.
      </div>
      {site.status === "offline" && (
        <div className="notice" role="status">
          <Radio size={17} />
          <span>
            This site is offline. Worker statuses, running counts, and resource
            metrics are historical snapshots, not live activity. Queued commands
            wait for the agent to reconnect.
          </span>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          <Terminal size={17} />
          <span>{notice}</span>
        </div>
      )}
      {actionError && !confirm && <ErrorBanner message={actionError} />}
      <div className="tabs" role="tablist" aria-label="Site sections">
        {tabs.map((item, index) => (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="site-tabpanel"
            tabIndex={tab === item.id ? 0 : -1}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft")
                next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              setTab(tabs[next].id);
              document.getElementById(`tab-${tabs[next].id}`)?.focus();
            }}
          >
            <item.icon size={16} />
            {item.label}
            {item.id === "workers" && <span>{workers.length}</span>}
            {item.id === "proxies" && <span>{proxies.length}</span>}
          </button>
        ))}
      </div>
      <section
        id="site-tabpanel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
        className="tab-content"
      >
        {(tab === "overview" || tab === "statistics") && <Stats key={id} site={site} />}
        {tab === "overview" && (
          <>
            <div className="detail-stat-grid">
              <div className="detail-stat">
                <span>
                  <Bot size={17} />
                  Workers reported
                </span>
                <strong>
                  {workers.length}
                  <small>
                    {site.healthy_workers} healthy at last heartbeat
                  </small>
                </strong>
              </div>
              <div className="detail-stat">
                <span>
                  <Activity size={17} />
                  Running workers
                </span>
                <strong>
                  {running}
                  <small>
                    {site.status === "offline"
                      ? "Stale snapshot · offline"
                      : `of ${workers.length} at last heartbeat`}
                  </small>
                </strong>
              </div>
              <div className="detail-stat">
                <span>
                  <Check size={17} />
                  Tasks completed
                </span>
                <strong>
                  {totalTasks.toLocaleString()}
                  <small>Last reported worker snapshot</small>
                </strong>
              </div>
              <div className="detail-stat">
                <span>
                  <Network size={17} />
                  Proxy pool
                </span>
                <strong>
                  {proxies.length}
                  <small>Available routes</small>
                </strong>
              </div>
            </div>
            <div className="detail-columns">
              <Commands commands={commands} />
              <div className="detail-aside">
                <div className="panel">
                  <div className="panel-heading">
                    <h3>Site information</h3>
                    <Globe2 size={18} />
                  </div>
                  <div className="site-information">
                    <p>
                      {site.description ||
                        "No description added. Edit this site to give it some context."}
                    </p>
                    <dl>
                      <div>
                        <dt>Created</dt>
                        <dd>{dateTime(site.created_at)}</dd>
                      </div>
                      <div>
                        <dt>Last heartbeat</dt>
                        <dd>{dateTime(site.last_seen)}</dd>
                      </div>
                      <div>
                        <dt>Desired workers</dt>
                        <dd>{config.number_of_workers}</dd>
                      </div>
                      <div>
                        <dt>AI preset</dt>
                        <dd>{config.ai_preset_id || "Not set"}</dd>
                      </div>
                      <div>
                        <dt>Site ID</dt>
                        <dd className="mono site-id">{site.id}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <div className="panel agent-panel">
                  <span className="agent-security">
                    <ShieldCheck size={23} />
                  </span>
                  <h3>Agent access</h3>
                  <p>
                    Tokens are site-scoped. Rotating a token immediately revokes
                    the previous one.
                  </p>
                  <button
                    className="button full"
                    onClick={() => openConfirm("rotate")}
                  >
                    <KeyRound size={15} />
                    Rotate agent token
                  </button>
                </div>
              </div>
            </div>
            <div className="section-heading inner-heading">
              <div>
                <h2>Recent events</h2>
                <p>The latest reports from this site.</p>
              </div>
              <button className="text-button" onClick={() => setTab("logs")}>
                View latest logs
                <ArrowUpRight size={15} />
              </button>
            </div>
            <ErrorList errors={errors} compact />
            <div className="danger-zone">
              <div>
                <h3>Delete this site</h3>
                <p>Permanently remove the site and its associated data.</p>
              </div>
              <button
                className="button danger-outline"
                onClick={() => openConfirm("delete")}
              >
                <Trash2 size={15} />
                Delete site
              </button>
            </div>
          </>
        )}
        {tab === "workers" && (
          <>
            <div className="section-heading inner-heading">
              <div>
                <h2>
                  Worker fleet <span className="count">{workers.length}</span>
                </h2>
                <p>
                  Actual state from the latest agent heartbeat. An offline site
                  may have stale worker reports.
                </p>
              </div>
            </div>
            <Workers workers={workers} />
            <div className="section-heading inner-heading">
              <div>
                <h2>Lifecycle commands</h2>
                <p>
                  Track delivery and execution separately from reported worker
                  health.
                </p>
              </div>
            </div>
            <Commands commands={commands} />
          </>
        )}
        {tab === "logs" && (
          <>
            <div className="section-heading inner-heading">
              <div>
                <h2>Event logs</h2>
                <p>Search the latest 100 reported events and filter by severity.</p>
              </div>
            </div>
            <ErrorList errors={errors} />
          </>
        )}
        {tab === "configuration" && (
          <Configuration site={site} config={config} onSaved={changed} />
        )}
        {tab === "proxies" && (
          <Proxies siteId={id} proxies={proxies} onChange={changed} />
        )}
        {tab === "backups" && <Backups key={id} site={site} />}
      </section>
      <div className="detail-sync">
        {updatedAt && `Last synced ${updatedAt.toLocaleTimeString()}`} ·
        Refreshes every 10 seconds
      </div>
      {edit && (
        <EditSite
          site={site}
          onClose={() => setEdit(false)}
          onSaved={changed}
        />
      )}
      {confirm && (
        <Confirm
          title={
            confirm === "delete"
              ? "Delete this site?"
              : confirm === "rotate"
                ? "Rotate agent token?"
                : `${confirm === "stop" ? "Stop" : "Restart"} workers?`
          }
          label={
            confirm === "delete"
              ? "Delete site permanently"
              : confirm === "rotate"
                ? "Rotate token"
                : `Dispatch ${confirm}`
          }
          busy={actionBusy}
          error={actionError}
          onConfirm={() => void confirmAction()}
          onClose={() => setConfirm(null)}
        >
          {confirm === "delete" ? (
            <>
              This permanently deletes <strong>{site.name}</strong> and its
              associated data. The agent token will stop working. This action
              cannot be undone. Deletion does not stop worker processes on the
              VPS: stop them and verify they have stopped before deleting.
              Active backup transfers or downloads prevent deletion. Once safe,
              local backup cache and history are removed; cloud copies remain.
            </>
          ) : confirm === "rotate" ? (
            <>
              The current token for <strong>{site.name}</strong> will stop
              working immediately. You must update the agent with the new token
              to reconnect.
            </>
          ) : (
            <>
              Queue a <strong>{confirm}</strong> command for{" "}
              <strong>{site.name}</strong>? The action runs when its agent
              receives it; actual worker state may take time to update.
            </>
          )}
        </Confirm>
      )}
      {token && <TokenModal token={token} onClose={() => setToken(null)} />}
    </>
  );
}
