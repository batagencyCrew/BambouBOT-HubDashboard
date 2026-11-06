import { BellOff, Check, CheckCheck } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/useAction";
import type { Alert } from "../lib/types";
import { IconButton } from "./ui";

/** Ack / mute / resolve buttons. Hidden entirely when the user lacks alerts:ack. */
export function AlertActions({ alert, onDone, showResolve }: { alert: Alert; onDone: () => void; showResolve?: boolean }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  if (!can("alerts:ack") || alert.status === "resolved") return null;

  const act = (verb: "ack" | "mute" | "resolve", body?: unknown) =>
    run(verb, () => api.post(`/alerts/${alert.id}/${verb}`, body), verb === "ack" ? "Alert acknowledged" : verb === "mute" ? "Muted for 1 hour" : "Alert resolved").then(onDone);

  return (
    <span className="alert-actions">
      {alert.status === "open" && (
        <IconButton label={`Acknowledge alert: ${alert.title}`} icon={<Check size={14} />} disabled={!!busy} onClick={(e) => { e.stopPropagation(); void act("ack"); }} />
      )}
      {alert.status !== "muted" && (
        <IconButton label={`Mute alert for 1 hour: ${alert.title}`} icon={<BellOff size={14} />} disabled={!!busy} onClick={(e) => { e.stopPropagation(); void act("mute", { minutes: 60 }); }} />
      )}
      {showResolve && (
        <IconButton label={`Resolve alert: ${alert.title}`} icon={<CheckCheck size={14} />} disabled={!!busy} onClick={(e) => { e.stopPropagation(); void act("resolve"); }} />
      )}
    </span>
  );
}
