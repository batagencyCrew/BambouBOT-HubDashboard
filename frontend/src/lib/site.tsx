import { createContext, useContext } from "react";
import { api } from "./api";
import { usePolling } from "./usePolling";
import type { Site } from "./types";

export interface SiteContextValue {
  site: Site;
  ref: string;
  reload: () => void;
}

export const SiteContext = createContext<SiteContextValue | null>(null);

export function useSite(): SiteContextValue {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error("useSite must be used inside the site page");
  return ctx;
}

/** Polls the site summary; the ref is the slug from the URL (backend accepts id/slug/name). */
export function useSiteSummary(ref: string | undefined) {
  return usePolling<Site>((signal) => api.get<Site>(`/sites/${encodeURIComponent(ref ?? "")}`, signal), 10_000, [ref]);
}
