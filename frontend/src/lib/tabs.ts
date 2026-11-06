/** The only thing persisted client-side: the last selected site tab. */
const KEY = "hub.lastSiteTab";

export const SITE_TABS = ["overview", "workers", "logs", "metrics", "costs", "files", "proxies", "backups", "settings"] as const;
export type SiteTab = (typeof SITE_TABS)[number];

export function lastSiteTab(): SiteTab {
  try {
    const value = localStorage.getItem(KEY);
    if (value && (SITE_TABS as readonly string[]).includes(value)) return value as SiteTab;
  } catch {
    /* storage disabled */
  }
  return "overview";
}

export function rememberSiteTab(tab: SiteTab) {
  try {
    localStorage.setItem(KEY, tab);
  } catch {
    /* storage disabled */
  }
}
