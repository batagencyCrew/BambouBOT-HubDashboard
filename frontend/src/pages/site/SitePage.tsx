import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";
import { SiteContext, useSiteSummary, type SiteContextValue } from "../../lib/site";
import { lastSiteTab, rememberSiteTab, SITE_TABS, type SiteTab } from "../../lib/tabs";
import { Spinner } from "../../components/ui";
import { SiteHeader } from "./SiteHeader";
import { OverviewTab } from "./OverviewTab";
import { WorkersTab } from "./WorkersTab";
import { LogsTab } from "./LogsTab";
import { MetricsTab } from "./MetricsTab";
import { CostsTab } from "./CostsTab";
import { FilesTab } from "./FilesTab";
import { ProxiesTab } from "./ProxiesTab";
import { BackupsTab } from "./BackupsTab";
import { SettingsTab } from "./SettingsTab";

const TAB_COMPONENTS: Record<SiteTab, React.ComponentType> = {
  overview: OverviewTab,
  workers: WorkersTab,
  logs: LogsTab,
  metrics: MetricsTab,
  costs: CostsTab,
  files: FilesTab,
  proxies: ProxiesTab,
  backups: BackupsTab,
  settings: SettingsTab,
};

export function SitePage() {
  const { ref, tab } = useParams<{ ref: string; tab?: string }>();
  const { data: site, error, refresh } = useSiteSummary(ref);

  useEffect(() => {
    if (tab && (SITE_TABS as readonly string[]).includes(tab)) rememberSiteTab(tab as SiteTab);
  }, [tab]);

  if (!site) {
    if (error) return <div className="error-note" role="alert">{error}</div>;
    return <Spinner label="Loading site" />;
  }

  if (!tab) return <Navigate to={`/sites/${site.slug}/${lastSiteTab()}`} replace />;
  if (!(SITE_TABS as readonly string[]).includes(tab)) return <Navigate to={`/sites/${site.slug}/overview`} replace />;

  const ctx: SiteContextValue = { site, ref: site.slug, reload: refresh };
  const Tab = TAB_COMPONENTS[tab as SiteTab];

  return (
    <SiteContext.Provider value={ctx}>
      <SiteHeader activeTab={tab as SiteTab} />
      <div style={{ marginTop: 14 }}>
        <Tab />
      </div>
    </SiteContext.Provider>
  );
}
