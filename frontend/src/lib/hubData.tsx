import { createContext, useContext, useMemo, type ReactNode } from "react";
import { api } from "./api";
import { usePolling } from "./usePolling";
import type { Alert, Overview } from "./types";

interface HubData {
  overview: Overview | null;
  alerts: Alert[];
  connected: boolean;
  lastError: string | null;
  refresh: () => void;
}

const HubDataContext = createContext<HubData | null>(null);

/** Shared 10s polls for /overview and active alerts (sidebar, overview page, badges). */
export function HubDataProvider({ children }: { children: ReactNode }) {
  const overview = usePolling<Overview>((signal) => api.get<Overview>("/overview", signal), 10_000);
  const alerts = usePolling<Alert[]>((signal) => api.get<Alert[]>("/alerts?status=active&limit=200", signal), 10_000);

  const value = useMemo<HubData>(
    () => ({
      overview: overview.data,
      alerts: alerts.data ?? [],
      connected: overview.error === null && overview.data !== null,
      lastError: overview.error,
      refresh: () => {
        overview.refresh();
        alerts.refresh();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview.data, overview.error, alerts.data],
  );
  return <HubDataContext.Provider value={value}>{children}</HubDataContext.Provider>;
}

export function useHubData(): HubData {
  const ctx = useContext(HubDataContext);
  if (!ctx) throw new Error("useHubData must be used inside HubDataProvider");
  return ctx;
}
