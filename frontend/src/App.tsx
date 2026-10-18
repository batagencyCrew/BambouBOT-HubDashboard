import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  Globe2,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, auth, errorMessage, json } from "./api";
import type { Overview, Site } from "./types";
import {
  Badge,
  Brand,
  Empty,
  ErrorBanner,
  Loading,
  Modal,
  relativeTime,
  TokenModal,
} from "./ui";
import { usePolling } from "./usePolling";
import SiteDetail from "./SiteDetail";
import { ErrorList } from "./components";

function Login({
  onLogin,
  expired,
}: {
  onLogin: () => void;
  expired: boolean;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        access_token: string;
        token_type: string;
        expires_in: number;
      }>("/auth/login", json("POST", { password }));
      auth.set(result.access_token);
      setPassword("");
      onLogin();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-glow" />
      <div className="login-panel">
        <Brand />
        <div className="login-symbol">
          <ShieldCheck size={30} />
        </div>
        <span className="eyebrow">YOUR OPERATIONS, CONNECTED</span>
        <h1>Welcome to the hub.</h1>
        <p className="muted">
          One workspace. Every site. Stay in control of your automation
          infrastructure.
        </p>
        <form onSubmit={(event) => void submit(event)}>
          {expired && (
            <div className="notice">
              Your session has ended. Sign in to continue.
            </div>
          )}
          {error && <ErrorBanner message={error} />}
          <label className="field">
            Admin password
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your dashboard password"
            />
          </label>
          <button className="button primary full" disabled={busy || !password}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <ArrowRight size={18} />
            )}
            Sign in to workspace
          </button>
        </form>
        <div className="login-footer">
          <ShieldCheck size={14} /> Secure admin access · Session expires after
          8 hours
        </div>
      </div>
      <span className="login-bottom">
        BAMBOU AUTOMATION HUB <span>Built for the bigger picture.</span>
      </span>
    </main>
  );
}

function CreateSite({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (site: Site, token: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error(
          "Enter an HTTP or HTTPS URL without embedded credentials.",
        );
      if (!name.trim()) throw new Error("A site name is required.");
      setBusy(true);
      const result = await api<{ site: Site; agent_token: string }>(
        "/sites",
        json("POST", {
          name: name.trim(),
          url: url.trim(),
          description: description.trim(),
        }),
      );
      onCreated(result.site, result.agent_token);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Connect a new site"
      subtitle="Give your automation a home in the hub."
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
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              placeholder="e.g. Production storefront"
              autoFocus
            />
          </label>
          <label className="field">
            Site URL
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              maxLength={2048}
              placeholder="https://example.com"
            />
          </label>
          <label className="field">
            Description <span className="optional">Optional</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              placeholder="What does this site automate?"
              rows={3}
            />
          </label>
          <div className="notice">
            <ShieldCheck size={18} />
            <span>
              A unique agent token will be generated. You’ll see it only once
              after creating the site.
            </span>
          </div>
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
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}
            Create site
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Dashboard({
  data,
  selectSite,
  createSite,
}: {
  data: Overview;
  selectSite: (id: string) => void;
  createSite: () => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const sites = data.sites.filter(
    (site) =>
      (status === "all" || site.status === status) &&
      `${site.name} ${site.url}`.toLowerCase().includes(search.toLowerCase()),
  );
  const stats = [
    {
      label: "Total sites",
      value: data.summary.sites,
      icon: Globe2,
      note: "Connected to your hub",
      className: "teal",
    },
    {
      label: "Healthy sites",
      value: data.summary.healthy,
      icon: ShieldCheck,
      note: data.summary.sites
        ? `${Math.round((data.summary.healthy / data.summary.sites) * 100)}% of your infrastructure`
        : "Waiting for your first agent",
      className: "green",
    },
    {
      label: "Total workers",
      value: data.summary.workers,
      icon: Bot,
      note: "Across all connected sites",
      className: "blue",
    },
    {
      label: "Running workers",
      value: data.summary.running,
      icon: Activity,
      note: "Last snapshots · may be stale offline",
      className: "purple",
    },
  ];
  return (
    <>
      <section className="stats-grid" aria-label="Infrastructure summary">
        {stats.map((stat) => (
          <div className="stat-card" key={stat.label}>
            <div className="stat-top">
              <span>{stat.label}</span>
              <span className={`stat-icon ${stat.className}`}>
                <stat.icon size={20} />
              </span>
            </div>
            <strong className="stat-number">
              {stat.value.toLocaleString()}
            </strong>
            <div className="stat-note">
              <span className={`tiny-dot ${stat.className}`} />
              {stat.note}
            </div>
          </div>
        ))}
      </section>
      <div className="section-heading">
        <div>
          <h2>
            Your sites <span className="count">{data.sites.length}</span>
          </h2>
          <p>A live view of your automation infrastructure.</p>
        </div>
        <button className="button primary" onClick={createSite}>
          <Plus size={17} />
          Add site
        </button>
      </div>
      <div className="site-toolbar">
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="Search sites"
            placeholder="Search sites by name or URL…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="filter-select">
          <span>Status</span>
          <select
            aria-label="Filter sites by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="healthy">Healthy</option>
            <option value="degraded">Degraded</option>
            <option value="offline">Offline</option>
          </select>
        </label>
      </div>
      {sites.length ? (
        <section className="sites-grid" aria-label="Connected sites">
          {sites.map((site) => (
            <button
              className="site-card"
              key={site.id}
              onClick={() => selectSite(site.id)}
            >
              <div className="site-card-top">
                <span className={`site-avatar ${site.status}`}>
                  <Globe2 size={23} />
                </span>
                <Badge value={site.status} />
              </div>
              <h3>{site.name}</h3>
              <span className="site-url">
                {site.url}
                <ArrowUpRight size={13} />
              </span>
              <p className="site-description">
                {site.description || "No description added."}
              </p>
              <div className="worker-line">
                <span>
                  <Bot size={16} />
                  {site.worker_count} workers
                </span>
                <span>{site.healthy_workers} healthy</span>
              </div>
              <div className="health-track">
                <span
                  style={{
                    width: `${site.worker_count ? Math.min(100, (site.healthy_workers / site.worker_count) * 100) : 0}%`,
                  }}
                />
              </div>
              <div className="site-card-bottom">
                <span>
                  <Radio size={13} />
                  {relativeTime(site.last_seen)}
                </span>
                <span className="view-site">
                  View site
                  <ArrowRight size={14} />
                </span>
              </div>
            </button>
          ))}
        </section>
      ) : (
        <div className="panel">
          <Empty
            title={
              data.sites.length
                ? "No matching sites"
                : "Your next automation starts here"
            }
          >
            {data.sites.length
              ? "Try another search or status filter."
              : "Add your first site, then connect its agent to see live health and workers."}
          </Empty>
          {!data.sites.length && (
            <div className="empty-action">
              <button className="button primary" onClick={createSite}>
                <Plus size={16} />
                Connect your first site
              </button>
            </div>
          )}
        </div>
      )}
      <div className="section-heading errors-heading">
        <div>
          <h2>
            Recent events <span className="section-dot" />
          </h2>
          <p>The latest signals from your connected sites.</p>
        </div>
        <span className="subtle-label">LATEST REPORTED EVENTS</span>
      </div>
      <ErrorList errors={data.recent_errors} onSite={selectSite} compact />
    </>
  );
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [create, setCreate] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const load = useCallback(() => api<Overview>("/overview"), []);
  const { data, error, refreshing, updatedAt, refresh } = usePolling(load);
  const selectSite = (id: string | null) => {
    setSelected(id);
    setMobileNav(false);
  };
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-initial">B</span>
          <div>
            <strong>Main workspace</strong>
            <span>Administrator</span>
          </div>
          <ShieldCheck size={15} />
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${!selected ? "active" : ""}`}
            onClick={() => selectSite(null)}
          >
            <LayoutDashboard size={19} />
            Overview
            <span className="nav-count">{data?.summary.sites ?? "—"}</span>
          </button>
          <div className="nav-section">
            <span>CONNECTED SITES</span>
            <button
              className="icon-button"
              aria-label="Add site"
              onClick={() => {
                setCreate(true);
                setMobileNav(false);
              }}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="site-nav">
            {data?.sites.map((site) => (
              <button
                key={site.id}
                className={`nav-item site-nav-item ${selected === site.id ? "active" : ""}`}
                onClick={() => selectSite(site.id)}
              >
                <span className={`status-dot ${site.status}`} />
                <span className="truncate">{site.name}</span>
                <ChevronRight size={14} />
              </button>
            ))}
            {data && !data.sites.length && (
              <p className="nav-empty">
                Your connected sites will appear here.
              </p>
            )}
          </div>
        </nav>
        <div className="sidebar-bottom">
          <div className="agent-note">
            <span className="agent-note-icon">
              <Radio size={18} />
            </span>
            <strong>Always in the loop</strong>
            <p>
              Health, workers, and events.
              <br />
              All in one place.
            </p>
            <span>
              <span className="live-dot" />
              Refreshes every 10s
            </span>
          </div>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            Connection guide
            <ExternalLink size={13} />
          </button>
          <button className="nav-item" onClick={onLogout}>
            <LogOut size={18} />
            Sign out
          </button>
          <div className="sidebar-version">
            <span className="brand-dot">◆</span> BAMBOU HUB <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-icon">
              <Server size={16} />
            </span>
            <button onClick={() => selectSite(null)}>Workspace</button>
            <ChevronRight size={14} />
            <span>{selected ? "Site details" : "Overview"}</span>
          </div>
          <div className="topbar-right">
            <span className="live-indicator">
              <span className={error ? "warning-dot" : "live-dot"} />
              {error
                ? "Connection issue"
                : updatedAt
                  ? "Live updates"
                  : "Connecting"}
            </span>
            <span className="topbar-divider" />
            <span className="admin-avatar" title="Administrator">
              AD
            </span>
          </div>
        </header>
        <main className="main-content">
          {selected ? (
            <SiteDetail
              key={selected}
              id={selected}
              onDeleted={() => {
                setSelected(null);
                void refresh();
              }}
              onChange={() => void refresh()}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">WORKSPACE OVERVIEW</div>
                  <h1>
                    Your automation, at a glance
                    <span className="heading-dot">.</span>
                  </h1>
                  <p>Everything you need to keep things running smoothly.</p>
                </div>
                <button
                  className="button"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                >
                  <RefreshCw size={16} className={refreshing ? "spin" : ""} />
                  Refresh
                </button>
              </div>
              <div className="overview-status">
                <span>
                  <span className={error ? "warning-dot" : "live-dot"} />
                  {error
                    ? "Unable to reach the hub"
                    : !data
                      ? "Connecting to your hub"
                      : data.summary.sites === 0
                        ? "Ready for your first connection"
                        : data.summary.healthy === data.summary.sites
                          ? "All sites are healthy"
                          : `${data.summary.sites - data.summary.healthy} site${data.summary.sites - data.summary.healthy === 1 ? "" : "s"} need attention`}
                </span>
                <span>
                  {updatedAt
                    ? `Last synced ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                    : "Waiting for data"}
                  <span className="status-divider">/</span> Auto-refresh 10s
                </span>
              </div>
              {error && (
                <ErrorBanner message={error} retry={() => void refresh()} />
              )}
              {data ? (
                <Dashboard
                  data={data}
                  selectSite={(id) => selectSite(id)}
                  createSite={() => setCreate(true)}
                />
              ) : (
                !error && <Loading />
              )}
            </>
          )}
          <footer className="content-footer">
            <span>Bambou Automation Hub</span>
            <span>
              <ArrowDownRight size={13} />
              Live data. No guesswork.
            </span>
          </footer>
        </main>
      </div>
      {create && (
        <CreateSite
          onClose={() => setCreate(false)}
          onCreated={(_site, newToken) => {
            setCreate(false);
            setToken(newToken);
            void refresh();
          }}
        />
      )}
      {token && <TokenModal token={token} onClose={() => setToken(null)} />}
      {help && (
        <Modal
          title="Connect your agent"
          subtitle="From a new site to a live heartbeat."
          onClose={() => setHelp(false)}
        >
          <div className="modal-body guide">
            <ol>
              <li>
                <strong>Create a site</strong>
                <p>
                  Add its name and URL, then save the one-time agent token
                  securely.
                </p>
              </li>
              <li>
                <strong>Configure your local agent</strong>
                <p>
                  Point the agent at this hub and use its token in the
                  Authorization: Bearer header. Use HTTPS for public
                  deployments.
                </p>
              </li>
              <li>
                <strong>Start sending heartbeats</strong>
                <p>
                  POST /api/agent/heartbeat every 15 seconds. Poll commands
                  every 5 seconds and refresh configuration every 30 seconds.
                </p>
              </li>
            </ol>
            <div className="notice">
              A site is offline after 60 seconds without a heartbeat. Commands
              remain pending until an agent receives and acknowledges them.
            </div>
          </div>
          <div className="modal-footer">
            <button className="button primary" onClick={() => setHelp(false)}>
              Got it
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function App() {
  const [signedIn, setSignedIn] = useState(() => Boolean(auth.get()));
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const unauthorized = () => {
      setSignedIn(false);
      setExpired(true);
    };
    window.addEventListener("bambou:unauthorized", unauthorized);
    return () =>
      window.removeEventListener("bambou:unauthorized", unauthorized);
  }, []);
  return signedIn ? (
    <Workspace
      onLogout={() => {
        auth.clear();
        setExpired(false);
        setSignedIn(false);
      }}
    />
  ) : (
    <Login
      expired={expired}
      onLogin={() => {
        setSignedIn(true);
        setExpired(false);
      }}
    />
  );
}
