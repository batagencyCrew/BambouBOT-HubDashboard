import { api } from "../../lib/api";
import { useSite } from "../../lib/site";
import { useLoad } from "../../lib/usePolling";
import type { Worker } from "../../lib/types";
import { LogViewer } from "../../components/LogViewer";

export function LogsTab() {
  const { ref } = useSite();
  const workers = useLoad<Worker[]>((signal) => api.get<Worker[]>(`/sites/${ref}/workers?include_stale=true`, signal), [ref]);
  return <LogViewer key={ref} site={ref} workers={(workers.data ?? []).map((w) => ({ id: w.id, name: w.name }))} />;
}
