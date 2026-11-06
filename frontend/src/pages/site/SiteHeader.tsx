import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pause, Play, RotateCw, Square, Users } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtAgo } from "../../lib/format";
import { rememberSiteTab, type SiteTab } from "../../lib/tabs";
import { useAction } from "../../lib/useAction";
import { useSite } from "../../lib/site";
import type { Command } from "../../lib/types";
import { ConfirmDialog } from "../../components/Confirm";
import { Badge, Button, HealthBadge, Tabs } from "../../components/ui";

export function SiteHeader({ activeTab }: { activeTab: SiteTab }) {
  const { site, reload } = useSite();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const navigate = useNavigate();
  const [count, setCount] = useState<string>("");
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const siteId = site.id;
  const offline = !site.online;
  const anyControl = ["control:lifecycle", "control:pause", "control:workers"].some((p) => can(p, siteId));
  const controlNote = !anyControl
    ? "Controls disabled: your role has no control permissions for this site."
    : offline
      ? "Controls disabled: the agent is offline."
      : null;

  const send = (action: string, args: Record<string, unknown> = {}, key = action) =>
    run(key, () => api.post<Command>(`/sites/${site.slug}/commands`, { action, args }), () =>
      `${action} sent (${site.online ? "delivered" : "queued"})`,
    ).then((r) => {
      if (r) {
        reload();
        setCount("");
      }
      return r;
    });

  function blockReason(permission: string): string | undefined {
    if (!can(permission, siteId)) return "You don't have permission for this action";
    if (offline) return "Agent is offline — commands can't be delivered right now";
    return undefined;
  }

  function go(tab: string) {
    rememberSiteTab(tab as SiteTab);
    navigate(`/sites/${site.slug}/${tab}`);
  }

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div className="row">
            <h1 className="page-title truncate">{site.name}</h1>
            <HealthBadge health={site.health} />
            <Badge status={site.desired_state === "running" ? "running" : site.desired_state === "paused" ? "idle" : "stopped"} dot={false}>
              desired: {site.desired_state}
            </Badge>
            {site.process?.crash_loop && <Badge status="error">crash loop</Badge>}
          </div>
          <p className="page-sub">
            <span className="mono">{site.slug}</span> · {site.online ? "agent linked" : "agent offline"} · last seen {fmtAgo(site.last_seen_at)}
            {site.agent_version ? <> · agent {site.agent_version}</> : null}
            {site.url ? <> · <a href={site.url} target="_blank" rel="noreferrer">{site.url}</a></> : null}
          </p>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
          <div className="row">
            <Button size="sm" icon={<Play size={13} />} loading={busy === "start"} disabled={!!blockReason("control:lifecycle")} title={blockReason("control:lifecycle") ?? "Start the script"} onClick={() => void send("start")}>
              Start
            </Button>
            {site.desired_state === "paused" ? (
              <Button size="sm" icon={<Play size={13} />} loading={busy === "resume"} disabled={!!blockReason("control:pause")} title={blockReason("control:pause") ?? "Resume the script"} onClick={() => void send("resume")}>
                Resume
              </Button>
            ) : (
              <Button size="sm" icon={<Pause size={13} />} loading={busy === "pause"} disabled={!!blockReason("control:pause")} title={blockReason("control:pause") ?? "Pause the script"} onClick={() => void send("pause")}>
                Pause
              </Button>
            )}
            <Button size="sm" icon={<Square size={13} />} variant="danger" loading={busy === "stop"} disabled={!!blockReason("control:lifecycle")} title={blockReason("control:lifecycle") ?? "Stop the script"} onClick={() => setConfirmStop(true)}>
              Stop
            </Button>
            <Button size="sm" icon={<RotateCw size={13} />} loading={busy === "restart"} disabled={!!blockReason("control:lifecycle")} title={blockReason("control:lifecycle") ?? "Restart the script"} onClick={() => setConfirmRestart(true)}>
              Restart
            </Button>
            <span className="row" style={{ gap: 4 }}>
              <input
                className="input"
                style={{ width: 92 }}
                type="number"
                min={0}
                max={1000}
                placeholder={`${site.worker_total} now`}
                aria-label="Worker count"
                value={count}
                disabled={!!blockReason("control:workers")}
                onChange={(e) => setCount(e.target.value)}
              />
              <Button
                size="sm"
                icon={<Users size={13} />}
                disabled={count === "" || !!blockReason("control:workers")}
                loading={busy === "set_workers"}
                title={blockReason("control:workers") ?? "Set the number of workers"}
                onClick={() => void send("set_workers", { count: Number(count) })}
              >
                Set workers
              </Button>
            </span>
          </div>
          {controlNote && <span className="muted-dim">{controlNote}</span>}
        </div>
      </div>
      {!site.online && (
        <div className="notice notice-warn">
          Agent is not connected. Control buttons are disabled; telemetry may be stale.
        </div>
      )}
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "workers", label: "Workers", count: site.worker_total },
          { id: "logs", label: "Logs" },
          { id: "metrics", label: "Metrics" },
          { id: "costs", label: "Costs" },
          { id: "files", label: "Files" },
          { id: "proxies", label: "Proxies" },
          { id: "backups", label: "Backups" },
          { id: "settings", label: "Settings" },
        ]}
        active={activeTab}
        onChange={go}
        label="Site sections"
      />
      <ConfirmDialog
        open={confirmStop}
        title="Stop the script?"
        message={<>This sets the desired state to <b>stopped</b>; the agent will not restart the script until you start it again.</>}
        confirmLabel="Stop"
        danger
        busy={busy === "stop"}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void send("stop");
        }}
      />
      <ConfirmDialog
        open={confirmRestart}
        title="Restart the script?"
        message="The running process is stopped and started again. In-flight work is interrupted."
        confirmLabel="Restart"
        busy={busy === "restart"}
        onClose={() => setConfirmRestart(false)}
        onConfirm={() => {
          setConfirmRestart(false);
          void send("restart");
        }}
      />
    </div>
  );
}
