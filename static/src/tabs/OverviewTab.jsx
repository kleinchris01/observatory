import React from "react";
import { view } from "@forge/bridge";
import { handleJiraLinkClick } from "../utils";
import { Icon } from "../components/Icons";
import { Panel, EmptyState } from "../components/ui";
import { FirstRunPanel } from "../components/admin/FirstRunPanel";

// The admin landing tab. Composition only -- the dashboard itself lives in
// components/OverviewDashboard.jsx.

const OverviewDashboard = React.lazy(() => import("../components/OverviewDashboard").then((m) => ({ default: m.OverviewDashboard })));

export function OverviewTab({ overview, onMigrateNamespace, migratingNamespace, onOpenRqtIndex, onNavigate }) {
  if (!overview) {
    return <EmptyState>Loading overview…</EmptyState>;
  }

  const { findingsSummary, findingsByCode } = overview;

  return (
    <div className="admin-overview">
      {/* First, above everything. On a site that has finished setting itself up this renders
          nothing at all -- it decides that for itself from the estate rather than from a
          flag, so it cannot linger after the work it describes is done. */}
      <FirstRunPanel onNavigate={onNavigate} />

      {overview.legacySummaryCount > 0 && (
        <div className="admin-migration-banner">
          <div className="admin-migration-banner__body">
            <Icon name="alertTriangle" size={15} />
            <div>
              <strong>{overview.legacySummaryCount} field scan records</strong> are stranded under the old Confluence-only storage key and won&apos;t appear in the admin view. Click &ldquo;Recover data&rdquo; to migrate them to the shared namespace.
            </div>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={onMigrateNamespace}
            disabled={migratingNamespace}
          >
            {migratingNamespace ? "Migrating…" : "Recover data"}
          </button>
        </div>
      )}

      <React.Suspense fallback={<EmptyState>Loading dashboard…</EmptyState>}>
        <OverviewDashboard
          dashboard={overview.dashboard}
          findingsSummary={findingsSummary}
          findingsByCode={findingsByCode}
          workflow={overview.workflow}
          screens={overview.screens}
          issueTypes={overview.issueTypes}
          users={overview.users}
          assets={overview.assets}
          access={overview.access}
          estate={overview.estate}
          automation={overview.automation}
          filters={overview.filters}
          dashboards={overview.dashboards}
          health={overview.health}
          onOpenRqtIndex={onOpenRqtIndex}
          onNavigate={onNavigate}
        />
      </React.Suspense>

      <Panel title="Atlassian Developer Console" icon="zap">
        <div className="admin-dev-links">
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/")}
          >
            <Icon name="zap" size={13} /> App overview
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/invocations"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/invocations")}
          >
            <Icon name="activity" size={13} /> Invocation metrics
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/storage"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/storage")}
          >
            <Icon name="layers" size={13} /> Storage / SQL
          </a>
          <a
            className="admin-dev-link"
            href="https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/logs"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => handleJiraLinkClick(e, "https://developer.atlassian.com/console/myapps/c11559cd-90ed-43a7-9a9b-80866237cd15/logs")}
          >
            <Icon name="info" size={13} /> App logs
          </a>
        </div>
      </Panel>
    </div>
  );
}
