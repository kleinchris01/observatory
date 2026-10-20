import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime, buildRovoPrompt } from "../utils";
import { Icon } from "../components/Icons";
import {
  StatTile,
  StatRow,
  Panel,
  EmptyState,
  Chip,
  PageHeader,
  PanelGrid,
  GridSpan,
  PillarHealthPanel,
  FindingRow,
  SortFilterBar,
  AskRovo,
  JiraLink,
} from "../components/ui";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, useVisiblePolling, usePersistentState } from "../hooks";
import { jiraLinks } from "../../../src/lib/jira-links.js";

// Jira Service Management: four scored pillars on one snapshot -- request types (and the fields
// each shows on the portal), queues, SLA outcomes, and customers & organizations. Read-only.
//
// Three things the Jira API cannot give are said on the page rather than worked around: SLA
// goals and calendars (SLAs are outcomes only), customers as people (counted, never listed),
// and knowledge base / approvals / CSAT (scopes this app does not hold).

const BUILD_POLL_MS = 3000;
const JSM_PILLARS = ["requestTypes", "queues", "slas", "customers"];

const FINDING_TONE = { high: "critical", medium: "warning", low: "neutral" };

function FindingChips({ findings = [] }) {
  return findings.map((f) => (
    <Chip key={f.code} tone={FINDING_TONE[f.severity] || "neutral"} title={f.detail}>
      {f.title}
    </Chip>
  ));
}

// A count that may be unmeasured. Null is "not measured", never zero.
function Count({ value, unit, lowerBound = false, unmeasuredTitle }) {
  if (value === null || value === undefined) {
    return (
      <Chip tone="neutral" title={unmeasuredTitle || "Not measured in the last build."}>
        Not measured
      </Chip>
    );
  }
  return (
    <Chip tone="neutral">
      {formatNumber(value)}
      {lowerBound ? "+" : ""} {unit}
    </Chip>
  );
}

function Row({ name, meta, children, link }) {
  return (
    <div className="issue-type-row">
      <div className="issue-type-row__identity">
        <span className="issue-type-row__name">{link ? <JiraLink href={link}>{name}</JiraLink> : name}</span>
        {meta && <span className="issue-type-row__desc">{meta}</span>}
      </div>
      <div className="issue-type-row__meta">{children}</div>
    </div>
  );
}

const findingFilterOptions = (rows, catalog) => [
  { value: "all", label: "All" },
  { value: "flagged", label: "Any finding", count: rows.filter((r) => r.findings?.length).length },
  ...Object.entries(catalog).map(([code, label]) => ({
    value: code,
    label,
    count: rows.filter((r) => (r.findings || []).some((f) => f.code === code)).length,
  })),
];

function applyFilters(rows, { term, finding, textOf }) {
  return rows.filter((r) => {
    if (finding === "flagged" && !r.findings?.length) return false;
    if (finding !== "all" && finding !== "flagged" && !(r.findings || []).some((f) => f.code === finding)) {
      return false;
    }
    return !term || textOf(r).toLowerCase().includes(term);
  });
}

function JsmFindings({ summary }) {
  const s = summary || {};
  const rows = [];
  const add = (count, tone, title, detail) => count > 0 && rows.push({ count, tone, title, detail });
  add(
    s.queues?.broken,
    "critical",
    "Queues naming a deleted custom field",
    "The queue errors or silently drops the clause; agents working from it miss issues.",
  );
  add(
    s.slas?.highBreach,
    "warning",
    "SLAs breached more often than met",
    "Over the last 90 days. Either the goal or the staffing is wrong.",
  );
  add(
    s.requestTypes?.hidden,
    "warning",
    "Request types not on the portal",
    "In no portal group, so customers cannot raise them.",
  );
  add(
    s.requestTypes?.duplicateNames,
    "warning",
    "Request types sharing a name on one desk",
    "The portal shows customers both.",
  );
  add(
    s.customers?.emptyOrganizations,
    "warning",
    "Organizations with no members",
    "A request shared with one reaches nobody.",
  );
  add(s.requestTypes?.unused, "info", "Request types with no request in 90 days", "Candidates to retire or merge.");
  add(s.slas?.unused, "info", "SLAs nothing ran against in 90 days", "Still evaluated on every request.");
  add(s.queues?.empty, "info", "Empty queues", "Fine when empty on purpose; clutter otherwise.");
  add(
    s.queues?.duplicates,
    "info",
    "Queues running the same query",
    "Agents split attention across two views of one list.",
  );
  add(s.customers?.unattachedOrganizations, "info", "Organizations no desk uses", "Attach or delete.");
  add(
    s.requestTypes?.undescribed,
    "info",
    "Request types with no description",
    "Customers choose from the name alone.",
  );

  return (
    <Panel
      title="What needs attention"
      icon="alertTriangle"
      description="What the four Service Management pillars of the site health score are built from."
    >
      {rows.length === 0 ? (
        <EmptyState inline>Nothing flagged on any desk.</EmptyState>
      ) : (
        rows.map((r) => <FindingRow key={r.title} tone={r.tone} title={r.title} detail={r.detail} count={r.count} />)
      )}
    </Panel>
  );
}

export function ServiceManagementTab({ intent, siteOrigin }) {
  const [view, setView] = usePersistentState("observatory.section.jsm", "overview");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [finding, setFinding] = React.useState("all");
  const [pillars, setPillars] = React.useState({});

  useNavIntent(intent, (nav) => {
    if (nav.view) setView(nav.view);
    setSearch(nav.search ?? "");
    setFinding(nav.finding ?? "all");
  });

  const load = React.useCallback(async () => {
    try {
      setData(await invoke("getJsmInventory", {}));
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the Service Management inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all(
      JSM_PILLARS.map((p) =>
        invoke("getPillarHealth", { pillar: p })
          .then((r) => [p, r?.pillar || null])
          .catch(() => [p, null]),
      ),
    ).then((entries) => {
      if (!cancelled) setPillars(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [data?.refreshedAt]);

  const isBuilding = ["building", "queued"].includes(data?.state) && !data?.staleBuild;
  useVisiblePolling(isBuilding, load, BUILD_POLL_MS);

  async function startBuild() {
    setBuilding(true);
    setError("");
    setNotice("");
    try {
      const result = await invoke("buildJsmInventory", {});
      await load();
      if (result?.error) setError(result.error);
      else if (result?.queued === false && result?.reason === "already-building")
        setNotice("A build is already running. This page refreshes itself while it does.");
      else setNotice("Build queued. This page refreshes itself while it runs.");
    } catch (err) {
      setError(err?.message || "Could not start the build.");
    } finally {
      setBuilding(false);
    }
  }

  const summary = data?.summary || {};
  const actions = (
    <>
      <AskRovo
        agent="observatory-jsm-expert"
        scope="Service Management"
        context="the snapshot age and each pillar's counts"
        disabled={Boolean(data?.neverBuilt) || data?.jsmEnabled === false}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Give me an overview of this site's Service Management setup and what to look at first.",
            facts: [
              ["Snapshot built", data?.refreshedAt || "unknown"],
              ["Service desks", summary.totalDesks ?? null],
              ["Request types", summary.requestTypes?.total ?? null],
              ["Queues", summary.queues?.total ?? null],
              [
                "SLA breach rate (90 days)",
                summary.slas?.breachRate == null ? null : `${Math.round(summary.slas.breachRate * 100)}%`,
              ],
            ],
          })
        }
      />
      <button type="button" className="secondary-button" onClick={startBuild} disabled={building || isBuilding}>
        <Icon name="refreshCw" size={13} />
        {isBuilding ? "Building…" : data?.neverBuilt ? "Build inventory" : "Rebuild"}
      </button>
    </>
  );

  if (loading && !data) return <div className="empty-state">Loading the Service Management inventory…</div>;

  const header = (
    <PageHeader
      title="Service Management"
      description="Service desks, request types, queues, SLA outcomes and customer organizations. Read-only — changes stay in Jira."
      meta={data?.refreshedAt ? `Built ${formatRelativeTime(data.refreshedAt)}` : "Never built"}
      actions={actions}
    />
  );
  const banners = (
    <>
      {error && (
        <div className="danger-zone__error" role="alert">
          {error}
        </div>
      )}
      {notice && !error && (
        <p className="admin-config-row__hint" role="status">
          {notice}
        </p>
      )}
      {isBuilding && <p className="admin-config-row__hint">Reading the service desks… this page refreshes itself.</p>}
      {data?.staleBuild && (
        <p className="admin-config-row__hint">A build was started but is no longer running. Rebuild to recover it.</p>
      )}
      {data?.lastError && data?.jsmEnabled !== false && !isBuilding && (
        <div className="danger-zone__error" role="alert">
          Last build failed: {data.lastError}
        </div>
      )}
    </>
  );

  if (data?.neverBuilt) {
    return (
      <div className="admin-issue-types">
        {header}
        {banners}
        <EmptyState action={actions}>
          No Service Management inventory has been built yet. Every full and quick scan produces one, or build it here.
        </EmptyState>
      </div>
    );
  }

  if (data?.jsmEnabled === false) {
    return (
      <div className="admin-issue-types">
        {header}
        {banners}
        <EmptyState>
          {data.reason || "Jira Service Management has no service desks on this site."} The four Service Management
          pillars are left out of the health score rather than scored.
        </EmptyState>
      </div>
    );
  }

  const term = search.trim().toLowerCase();
  const windowDays = data?.windowDays ?? 90;
  const desks = data?.desks || [];
  const requestTypes = data?.requestTypes || [];
  const queues = data?.queues || [];
  const slas = data?.slas || [];
  const organizations = data?.organizations || [];
  const deskKey = new Map(desks.map((d) => [d.deskId, d.projectKey]));

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    { key: "desks", label: "Desks", icon: "folder", badge: formatNumber(desks.length) },
    { key: "requestTypes", label: "Request types", icon: "clipboardText", badge: formatNumber(requestTypes.length) },
    { key: "queues", label: "Queues", icon: "listChecks", badge: formatNumber(queues.length) },
    { key: "slas", label: "SLAs", icon: "clock", badge: formatNumber(slas.length) },
    { key: "organizations", label: "Organizations", icon: "user", badge: formatNumber(organizations.length) },
  ];

  const filterBar = (rows, catalog, totalCount, filteredCount, placeholder) => (
    <SortFilterBar
      search={search}
      onSearchChange={setSearch}
      searchLabel="Search"
      searchPlaceholder={placeholder}
      filters={[
        {
          key: "finding",
          label: "Finding",
          value: finding,
          onChange: setFinding,
          options: findingFilterOptions(rows, catalog),
        },
      ]}
      resultCount={filteredCount}
      totalCount={totalCount}
      onClear={() => {
        setSearch("");
        setFinding("all");
      }}
    />
  );

  const shownTypes = applyFilters(requestTypes, { term, finding, textOf: (r) => `${r.name} ${deskKey.get(r.deskId)}` });
  const shownQueues = applyFilters(queues, {
    term,
    finding,
    textOf: (q) => `${q.name} ${q.jql} ${deskKey.get(q.deskId)}`,
  });
  const shownSlas = applyFilters(slas, { term, finding, textOf: (s) => `${s.name} ${s.fieldId}` });
  const shownOrgs = applyFilters(organizations, { term, finding, textOf: (o) => o.name });
  const shownDesks = desks.filter((d) => !term || `${d.projectKey} ${d.projectName}`.toLowerCase().includes(term));

  return (
    <div className="admin-issue-types">
      {header}
      {banners}

      <StatRow>
        <StatTile label="Service desks" value={formatNumber(summary.totalDesks ?? desks.length)} icon="folder" />
        <StatTile
          label="Request types"
          value={formatNumber(summary.requestTypes?.total ?? requestTypes.length)}
          hint={`${formatNumber(summary.requestTypes?.recentRequests ?? 0)} requests in ${windowDays} days`}
          icon="clipboardText"
        />
        <StatTile
          label="Broken queues"
          value={formatNumber(summary.queues?.broken ?? 0)}
          hint={(summary.queues?.broken ?? 0) > 0 ? "Name a deleted field" : "None"}
          tone={(summary.queues?.broken ?? 0) > 0 ? "critical" : "success"}
          icon="alertTriangle"
        />
        <StatTile
          label="SLA breach rate"
          value={summary.slas?.breachRate == null ? "—" : `${Math.round(summary.slas.breachRate * 100)}%`}
          hint={
            summary.slas?.activeRequests
              ? `${formatNumber(summary.slas.breachedRequests)} of ${formatNumber(summary.slas.activeRequests)} requests, ${windowDays} days`
              : "No SLA outcomes measured"
          }
          tone={summary.slas?.breachRate > 0.25 ? "warning" : "neutral"}
          icon="clock"
        />
      </StatRow>

      {data?.unreadCount > 0 && (
        <p className="admin-config-row__hint">
          {data.unreadCount} reads did not finish in the last build. Their counts show as "Not measured", never as zero.
        </p>
      )}

      <SubNavLayout
        items={items}
        activeKey={view}
        onSelect={(key) => {
          setView(key);
          setFinding("all");
        }}
      >
        {view === "overview" && (
          <PanelGrid>
            {JSM_PILLARS.map((p) => (
              <GridSpan key={p}>
                <PillarHealthPanel pillar={pillars[p] || null} />
              </GridSpan>
            ))}
            <GridSpan>
              <JsmFindings summary={summary} />
            </GridSpan>
            <GridSpan>
              <Panel title="What this pillar cannot see" icon="info">
                <p>
                  SLA goals and calendars have no REST endpoint, so SLAs are reported by outcome: requests measured
                  against each one, and how many breached, over the last {windowDays} days. Customers are counted, never
                  listed. Knowledge base, approvals and satisfaction scores need scopes this app does not hold.
                </p>
              </Panel>
            </GridSpan>
          </PanelGrid>
        )}

        {view === "desks" && (
          <Panel title="Service desks" icon="folder" description="Each desk with its customers and organizations.">
            <SortFilterBar
              search={search}
              onSearchChange={setSearch}
              searchLabel="Search desks"
              searchPlaceholder="Search by key or name…"
              resultCount={shownDesks.length}
              totalCount={desks.length}
              onClear={() => setSearch("")}
            />
            {shownDesks.map((d) => (
              <Row
                key={d.deskId}
                name={`${d.projectName || d.projectKey} (${d.projectKey})`}
                link={jiraLinks.requestTypes(siteOrigin, d.projectKey)}
              >
                <Count value={d.customerCount} unit="customers" lowerBound={d.customersComplete === false} />
                <Count value={d.orgCount} unit="organizations" />
                <Count value={d.portalGroupCount} unit="portal groups" />
              </Row>
            ))}
          </Panel>
        )}

        {view === "requestTypes" && (
          <Panel
            title="Request types"
            icon="clipboardText"
            description={`What customers can ask for on each desk, with requests in the last ${windowDays} days.`}
          >
            {filterBar(
              requestTypes,
              {
                hidden: "Not on the portal",
                unused: "Unused",
                undescribed: "No description",
                "duplicate-name": "Duplicate name",
              },
              requestTypes.length,
              shownTypes.length,
              "Search by name or desk…",
            )}
            {shownTypes.length === 0 ? (
              <EmptyState inline>No request types match.</EmptyState>
            ) : (
              shownTypes.map((r) => (
                <Row
                  key={`${r.deskId}:${r.id}`}
                  name={r.name}
                  meta={`${deskKey.get(r.deskId) || r.deskId}${r.fieldCount != null ? ` · ${r.fieldCount} fields, ${r.requiredFieldCount} required` : ""}`}
                  link={jiraLinks.requestType(siteOrigin, deskKey.get(r.deskId), r.id)}
                >
                  <Count value={r.recentCount} unit="requests" unmeasuredTitle="Request volume could not be counted." />
                  <FindingChips findings={r.findings} />
                </Row>
              ))
            )}
          </Panel>
        )}

        {view === "queues" && (
          <Panel
            title="Queues"
            icon="listChecks"
            description="What agents work from, with each queue's current issue count."
          >
            {filterBar(
              queues,
              { "broken-ref": "Names a deleted field", empty: "Empty", "duplicate-jql": "Same query" },
              queues.length,
              shownQueues.length,
              "Search by name, JQL or desk…",
            )}
            {shownQueues.length === 0 ? (
              <EmptyState inline>No queues match.</EmptyState>
            ) : (
              shownQueues.map((q) => (
                <Row
                  key={`${q.deskId}:${q.id}`}
                  name={q.name}
                  meta={`${deskKey.get(q.deskId) || q.deskId} · ${q.jql || "(no JQL)"}`}
                  link={jiraLinks.queue(siteOrigin, deskKey.get(q.deskId), q.id)}
                >
                  <Count value={q.issueCount} unit="issues" />
                  <FindingChips findings={q.findings} />
                </Row>
              ))
            )}
          </Panel>
        )}

        {view === "slas" && (
          <Panel
            title="SLAs"
            icon="clock"
            description={`Outcomes over the last ${windowDays} days. Goals and calendars are not readable through the Jira API.`}
          >
            {filterBar(
              slas,
              { "high-breach": "Breached more than met", unused: "Unused" },
              slas.length,
              shownSlas.length,
              "Search by SLA name…",
            )}
            {shownSlas.length === 0 ? (
              <EmptyState inline>{slas.length === 0 ? "No SLA fields on this site." : "No SLAs match."}</EmptyState>
            ) : (
              shownSlas.map((s) => (
                <Row
                  key={s.fieldId}
                  name={s.name}
                  meta={`${s.fieldId} · measured on ${s.measuredDesks} of ${s.desks.length} desks`}
                >
                  <Count value={s.measuredDesks > 0 ? s.activeCount : null} unit="requests" />
                  {s.breachRate != null && (
                    <Chip tone={s.breachRate > 0.5 ? "warning" : "neutral"}>
                      {Math.round(s.breachRate * 100)}% breached
                    </Chip>
                  )}
                  <FindingChips findings={s.findings} />
                </Row>
              ))
            )}
          </Panel>
        )}

        {view === "organizations" && (
          <Panel
            title="Organizations"
            icon="user"
            description="Customer organizations, with member counts. Members are never listed."
          >
            {filterBar(
              organizations,
              { empty: "No members", unattached: "No desk" },
              organizations.length,
              shownOrgs.length,
              "Search by name…",
            )}
            {shownOrgs.length === 0 ? (
              <EmptyState inline>
                {organizations.length === 0 ? "No organizations on this site." : "No organizations match."}
              </EmptyState>
            ) : (
              shownOrgs.map((o) => (
                <Row
                  key={o.id}
                  name={o.name}
                  meta={o.deskCount == null ? null : `${o.deskCount} desks`}
                  link={jiraLinks.organization(siteOrigin, o.id)}
                >
                  <Count value={o.memberCount} unit="members" lowerBound={o.membersComplete === false} />
                  <FindingChips findings={o.findings} />
                </Row>
              ))
            )}
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
