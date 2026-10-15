import React from "react";
import { invoke } from "@forge/bridge";
import { formatNumber, formatRelativeTime } from "../utils";
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
  LinkButton,
} from "../components/ui";
import { buildRovoPrompt } from "../utils";
import { SubNavLayout } from "../components/admin/primitives";
import { useNavIntent, useVisiblePolling, usePersistentState } from "../hooks";

// What Jira enforces on each field, per project and work type: field schemes, or -- on a site
// not yet migrated -- field configuration schemes and field configurations.
//
// The tab says which model it read every time, because the two answer different questions:
// field schemes decide which fields a project has at all (and never "hide" one); legacy
// configurations hide and require fields per work type. Read-only, like every pillar.

const BUILD_POLL_MS = 3000;
const AGENT = "observatory-fieldconfig-expert";

const CODE_CHIP = {
  unused: { tone: "warning", label: "unused" },
  duplicate: { tone: "warning", label: "duplicate" },
  "required-hidden": { tone: "critical", label: "required but hidden" },
  unmeasured: { tone: "neutral", label: "not read" },
};

function FindingChips({ codes = [], duplicateOfName }) {
  return codes.map((code) => (
    <Chip
      key={code}
      tone={CODE_CHIP[code]?.tone || "neutral"}
      title={code === "duplicate" && duplicateOfName ? `Identical to ${duplicateOfName}` : undefined}
    >
      {CODE_CHIP[code]?.label || code}
    </Chip>
  ));
}

// One scheme's or configuration's fields, fetched when opened. Legacy configurations list only
// the fields they hide, require or describe; every other field is visible and optional, which
// the panel says instead of listing thousands of rows.
function OwnerItems({ owner, kind, load = invoke }) {
  const [requiredOnly, setRequiredOnly] = React.useState(false);
  const [state, setState] = React.useState({ loading: true, data: null, error: "" });

  React.useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    load("getFieldConfigItems", { ownerKind: kind, ownerId: owner.id, requiredOnly, limit: 200 })
      .then((data) => {
        if (!cancelled) setState({ loading: false, data, error: "" });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, data: null, error: err?.message || "Could not load fields." });
      });
    return () => {
      cancelled = true;
    };
  }, [owner.id, kind, requiredOnly, load]);

  const { loading, data, error } = state;
  return (
    <div className="fc-items">
      <div className="fc-items__bar">
        <label className="fc-items__toggle">
          <input type="checkbox" checked={requiredOnly} onChange={(e) => setRequiredOnly(e.target.checked)} />
          Required only
        </label>
        <AskRovo
          agent={AGENT}
          scope={kind === "config" ? "this field configuration" : "this field scheme"}
          context={`the ${kind === "config" ? "configuration" : "scheme"}'s name, projects and findings`}
          buildPrompt={() =>
            buildRovoPrompt({
              task: `Explain the ${kind === "config" ? "field configuration" : "field scheme"} "${owner.name}": what it requires, who uses it, and what to fix first.`,
              facts: [
                ["Name", owner.name],
                ["Projects", owner.projectCount ?? null],
                ["Findings", (owner.codes || []).join(", ") || "none"],
              ],
            })
          }
        />
      </div>
      {kind === "config" && (
        <p className="ui-note">
          <Icon name="info" size={13} />
          <span>
            Only fields this configuration hides, requires or describes are listed; every other field is visible and
            optional.
          </span>
        </p>
      )}
      {error ? (
        <div className="danger-zone__error" role="alert">
          {error}
        </div>
      ) : loading && !data ? (
        <EmptyState inline>Loading fields…</EmptyState>
      ) : !data?.available ? (
        <EmptyState inline>No snapshot to read.</EmptyState>
      ) : !data.items.length ? (
        <EmptyState inline>
          {requiredOnly
            ? "No field is required here."
            : kind === "config"
              ? "No field is hidden, required or described here."
              : "No field is associated with this scheme."}
        </EmptyState>
      ) : (
        <ul className="ui-wfusage">
          {data.items.map((item) => (
            <li key={`${item.fieldId}-${item.workTypeId}`} className="ui-wfusage__row">
              <span className="ui-wfusage__workflow" title={item.fieldId}>
                {item.fieldName}
              </span>
              <span className="ui-wfusage__where">
                <span className="ui-transition__path">{item.workTypeName}</span>
              </span>
              <span className="ui-wfusage__what">
                {item.required && <Chip tone="warning">required</Chip>}
                {item.hidden && <Chip tone={item.required ? "critical" : "neutral"}>hidden</Chip>}
                {item.restrictedToNames?.length > 0 && (
                  <Chip title="Only these work types have the field">{`only ${item.restrictedToNames.join(", ")}`}</Chip>
                )}
                {item.renderer && <span className="ui-wfusage__summary">{item.renderer}</span>}
                {item.description && (
                  <span className="ui-wfusage__summary" title={item.description}>
                    has description
                  </span>
                )}
              </span>
            </li>
          ))}
          {data.total > data.items.length && (
            <li className="ui-wfusage__more">
              Showing {data.items.length} of {formatNumber(data.total)}.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function OwnerRow({ owner, kind, nameOf, expanded, onToggle }) {
  return (
    <div className="issue-type-row fc-row">
      <button type="button" className="fc-row__toggle" aria-expanded={expanded} onClick={onToggle}>
        <span className="issue-type-row__identity">
          <span className="issue-type-row__name">{owner.name}</span>
          {kind === "scheme" ? (
            <span className="issue-type-row__desc">
              {owner.projects?.length
                ? owner.projects.map((p) => p.projectKey).join(", ") + (owner.projectsTruncated ? "…" : "")
                : "No projects"}
            </span>
          ) : (
            <span className="issue-type-row__desc">
              {owner.routes?.length
                ? owner.routes
                    .map((r) => `${r.schemeName} · ${r.workTypeName}`)
                    .slice(0, 4)
                    .join("; ")
                : "No scheme routes to it"}
            </span>
          )}
        </span>
        <span className="issue-type-row__meta">
          {owner.isDefault && <Chip>default</Chip>}
          {kind === "scheme" && (
            <Chip>{`${formatNumber(owner.projectCount)} project${owner.projectCount === 1 ? "" : "s"}`}</Chip>
          )}
          {kind === "scheme" && owner.fieldCount != null && <Chip>{`${formatNumber(owner.fieldCount)} fields`}</Chip>}
          {(owner.requiredCount ?? 0) > 0 && <Chip>{`${formatNumber(owner.requiredCount)} required`}</Chip>}
          <FindingChips codes={owner.codes} duplicateOfName={nameOf(owner.duplicateOf)} />
          <Icon name={expanded ? "chevronUp" : "chevronDown"} size={13} />
        </span>
      </button>
      {expanded && <OwnerItems owner={owner} kind={kind} />}
    </div>
  );
}

function OwnerList({ rows, kind, intentFilter = "all" }) {
  const [search, setSearch] = React.useState("");
  const [show, setShow] = React.useState(intentFilter);
  const [open, setOpen] = React.useState(null);
  const nameOf = (id) => rows.find((r) => r.id === id)?.name || null;
  const q = search.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (show !== "all" && !(r.codes || []).includes(show)) return false;
    if (!q) return true;
    return [r.name, ...(r.projects || []).map((p) => p.projectKey)].some((v) =>
      String(v || "")
        .toLowerCase()
        .includes(q),
    );
  });
  const count = (code) => rows.filter((r) => (r.codes || []).includes(code)).length;
  const options = [
    { value: "all", label: "All" },
    { value: "unused", label: "Unused", count: count("unused") },
    { value: "duplicate", label: "Duplicates", count: count("duplicate") },
    ...(kind === "config"
      ? [{ value: "required-hidden", label: "Required but hidden", count: count("required-hidden") }]
      : []),
    { value: "unmeasured", label: "Not read", count: count("unmeasured") },
  ];

  return (
    <>
      <SortFilterBar
        search={search}
        onSearchChange={setSearch}
        searchLabel={kind === "config" ? "Search field configurations" : "Search field schemes"}
        searchPlaceholder={kind === "config" ? "Configuration name…" : "Scheme name or project key…"}
        filters={[{ key: "show", label: "Show", value: show, onChange: setShow, options }]}
        resultCount={visible.length}
        totalCount={rows.length}
        onClear={() => {
          setSearch("");
          setShow("all");
        }}
      />
      {visible.length === 0 ? (
        <EmptyState inline>{rows.length ? "Nothing matches these filters." : "None in this snapshot."}</EmptyState>
      ) : (
        <div className="issue-type-list">
          {visible.map((row) => (
            <OwnerRow
              key={row.id}
              owner={row}
              kind={kind}
              nameOf={nameOf}
              expanded={open === row.id}
              onToggle={() => setOpen(open === row.id ? null : row.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Findings({ data, onOpen }) {
  const s = data.summary || {};
  const legacy = data.source === "field-configurations";
  const rows = [];
  if (legacy && s.requiredHiddenConfigs > 0) {
    rows.push({
      key: "rh",
      tone: "critical",
      count: s.requiredHiddenPairs,
      title: "Fields required but hidden",
      detail: `In ${s.requiredHiddenConfigs} field configuration${s.requiredHiddenConfigs === 1 ? "" : "s"}. Nobody can fill them in, so every create or edit through them fails.`,
      open: () => onOpen("configs", "required-hidden"),
    });
  }
  const unused = (s.unusedSchemes || 0) + (s.unusedConfigs || 0);
  if (unused > 0)
    rows.push({
      key: "un",
      tone: "warning",
      count: unused,
      title: legacy ? "Field configurations and schemes no project uses" : "Field schemes no project uses",
      detail: "Configuration nobody sees, still maintained.",
      open: () => onOpen("schemes", "unused"),
    });
  if (s.reducible > 0)
    rows.push({
      key: "dup",
      tone: "warning",
      count: s.reducible,
      title: "Identical to another",
      detail: `${s.duplicateGroups} group${s.duplicateGroups === 1 ? "" : "s"}. Every change has to be made in each copy.`,
      open: () => onOpen(legacy ? "configs" : "schemes", "duplicate"),
    });
  if (s.inconsistentRequiredFields > 0)
    rows.push({
      key: "inc",
      tone: "info",
      count: s.inconsistentRequiredFields,
      title: "Fields required in some places and optional in others",
      detail:
        (data.inconsistentRequired || [])
          .slice(0, 5)
          .map((f) => f.fieldName)
          .join(", ") + ". Sometimes deliberate; worth a look when two projects disagree.",
    });

  return (
    <Panel
      title="What needs attention"
      icon="alertTriangle"
      description="What the field schemes pillar of the site health score is built from."
    >
      {rows.length === 0 ? (
        <EmptyState inline>Nothing flagged.</EmptyState>
      ) : (
        rows.map((r) => (
          <FindingRow
            key={r.key}
            tone={r.tone}
            title={r.title}
            detail={r.detail}
            count={r.count}
            action={r.open ? <LinkButton onClick={r.open}>Show</LinkButton> : null}
          />
        ))
      )}
    </Panel>
  );
}

export function FieldConfigsTab({ intent }) {
  const [view, setView] = usePersistentState("observatory.section.fieldConfigs", "overview");
  const [filter, setFilter] = React.useState({ view: null, show: "all", nonce: 0 });
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [building, setBuilding] = React.useState(false);
  const [pillar, setPillar] = React.useState(null);

  const openFiltered = React.useCallback(
    (nextView, show) => {
      setView(nextView);
      setFilter((f) => ({ view: nextView, show, nonce: f.nonce + 1 }));
    },
    [setView],
  );

  useNavIntent(intent, (nav) => {
    if (nav.view) openFiltered(nav.view, nav.filter || "all");
  });

  const load = React.useCallback(async () => {
    try {
      setData(await invoke("getFieldConfigInventory", {}));
      setError("");
    } catch (err) {
      setError(err?.message || "Could not load the field scheme inventory.");
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    let cancelled = false;
    invoke("getPillarHealth", { pillar: "fieldConfigs" })
      .then((result) => {
        if (!cancelled) setPillar(result?.pillar || null);
      })
      .catch(() => {
        if (!cancelled) setPillar(null);
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
      const result = await invoke("buildFieldConfigInventory", {});
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

  if (loading && !data) return <div className="empty-state">Loading the field scheme inventory…</div>;

  const s = data?.summary || {};
  const legacy = data?.source === "field-configurations";
  const actions = (
    <>
      <AskRovo
        agent={AGENT}
        scope="the field scheme estate"
        context="which model the site is on, the snapshot age and the finding counts"
        disabled={Boolean(data?.neverBuilt)}
        buildPrompt={() =>
          buildRovoPrompt({
            task: "Give me an overview of how this site configures fields per project -- required, hidden, which fields each project has -- and what to fix first.",
            facts: [
              ["Model", data?.sourceLabel || "unknown"],
              ["Snapshot built", data?.refreshedAt || "unknown"],
              ["Schemes", s.schemeCount ?? null],
              ["Field configurations", legacy ? s.configCount : "n/a"],
              ["Unused", (s.unusedSchemes || 0) + (s.unusedConfigs || 0)],
              ["Required but hidden", legacy ? s.requiredHiddenPairs : "n/a"],
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

  const header = (
    <PageHeader
      title="Field schemes"
      description="What Jira enforces on each field, per project and work type: required, hidden, described — and which fields a project has at all. Read-only."
      meta={
        data?.refreshedAt
          ? `Built ${formatRelativeTime(data.refreshedAt)}${data.sourceLabel ? ` · ${data.sourceLabel}` : ""}`
          : "Never built"
      }
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
      {isBuilding && <p className="admin-config-row__hint">Reading field schemes… this page refreshes itself.</p>}
      {data?.staleBuild && (
        <p className="admin-config-row__hint">A build was started but is no longer running. Rebuild to recover it.</p>
      )}
      {data?.lastError && !isBuilding && (
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
          No field scheme inventory has been built yet. Every full and quick scan produces it — or build it on its own
          here.
        </EmptyState>
      </div>
    );
  }

  const items = [
    { key: "overview", label: "Overview", icon: "barChart" },
    {
      key: "schemes",
      label: legacy ? "Configuration schemes" : "Field schemes",
      icon: "listChecks",
      badge: formatNumber(data.schemes.length),
    },
    ...(legacy
      ? [{ key: "configs", label: "Field configurations", icon: "layers", badge: formatNumber(data.configs.length) }]
      : []),
  ];
  const showFor = (v) => (filter.view === v ? filter.show : "all");

  return (
    <div className="admin-issue-types">
      {header}
      {banners}

      <p className="ui-note">
        <Icon name="info" size={13} />
        <span>
          {legacy ? (
            <>
              This site uses <strong>field configurations</strong>, which Jira is replacing with field schemes. Projects
              map each work type to a field configuration that hides or requires fields.
              {data.fallbackReason ? ` (Field schemes were not available: ${data.fallbackReason}.)` : ""}
            </>
          ) : (
            <>
              This site uses <strong>field schemes</strong>: each project&apos;s scheme lists the fields it has, and
              whether each is required, per work type. A field not in a project&apos;s scheme does not exist there.
            </>
          )}
          {data.unreadOwners > 0 &&
            ` ${formatNumber(data.unreadOwners)} could not be read on the last build and are left out of the rates.`}
        </span>
      </p>

      <StatRow>
        <StatTile
          label={legacy ? "Configuration schemes" : "Field schemes"}
          value={formatNumber(s.schemeCount ?? data.schemes.length)}
          icon="listChecks"
        />
        {legacy && (
          <StatTile
            label="Field configurations"
            value={formatNumber(s.configCount ?? data.configs.length)}
            icon="layers"
          />
        )}
        <StatTile
          label="Unused"
          value={formatNumber((s.unusedSchemes || 0) + (s.unusedConfigs || 0))}
          hint="no project uses them"
          tone={(s.unusedSchemes || 0) + (s.unusedConfigs || 0) > 0 ? "warning" : "success"}
          icon="clock"
        />
        {legacy ? (
          <StatTile
            label="Required but hidden"
            value={formatNumber(s.requiredHiddenPairs || 0)}
            hint="fields nobody can fill in"
            tone={s.requiredHiddenPairs > 0 ? "critical" : "success"}
            icon="alertTriangle"
          />
        ) : (
          <StatTile
            label="Identical schemes"
            value={formatNumber(s.reducible || 0)}
            hint={`${formatNumber(s.duplicateGroups || 0)} groups`}
            tone={s.reducible > 0 ? "warning" : "success"}
            icon="copy"
          />
        )}
      </StatRow>

      <SubNavLayout items={items} activeKey={view} onSelect={setView}>
        {view === "overview" && (
          <PanelGrid>
            <GridSpan>
              <PillarHealthPanel pillar={pillar} />
            </GridSpan>
            <GridSpan>
              <Findings data={data} onOpen={openFiltered} />
            </GridSpan>
          </PanelGrid>
        )}
        {view === "schemes" && (
          <Panel
            title={legacy ? "Field configuration schemes" : "Field schemes"}
            icon="listChecks"
            description={
              legacy
                ? "Each maps work types to field configurations. Projects with no scheme use the default field configuration."
                : "Each lists the fields its projects have, and what is required."
            }
          >
            <OwnerList
              key={`schemes-${filter.nonce}`}
              rows={data.schemes}
              kind="scheme"
              intentFilter={showFor("schemes")}
            />
          </Panel>
        )}
        {view === "configs" && legacy && (
          <Panel
            title="Field configurations"
            icon="layers"
            description="What each configuration hides, requires and describes. Open one to see its fields."
          >
            <OwnerList
              key={`configs-${filter.nonce}`}
              rows={data.configs}
              kind="config"
              intentFilter={showFor("configs")}
            />
          </Panel>
        )}
      </SubNavLayout>
    </div>
  );
}
