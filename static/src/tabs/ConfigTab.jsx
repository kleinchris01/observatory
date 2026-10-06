import React from "react";
import { AuditLogPanel } from "../components/admin/AuditLogPanel";
import { invoke, view } from "@forge/bridge";
import { Icon } from "../components/Icons";
import { DEFAULT_THRESHOLDS, DEFAULT_MACRO_ACCESS, DEFAULT_REMEDIATION, DEFAULT_CONFIG, DEFAULT_AUTOMATION_STALE_AFTER_DAYS } from "../admin-defaults";
import { Toggle, ConfigSection, ConfigRow, InlineThresholdInput, SubNavLayout } from "../components/admin/primitives";
import { PageHeader, StickyActions } from "../components/ui";
import { usePersistentState } from "../hooks";

// Governance thresholds, macro access and snapshot scheduling.


// Reports which Jira endpoints actually answer, rather than reasoning about which should.
//
// Three separate mysteries this week were settled this way and not by argument: a 401 that
// survived two wrong theories, a scan 400 that is still open, and an "Unknown SQL execution
// error" that was a placeholder in a LIMIT clause. This makes that move available without
// a redeploy.
export function AutomationProbePanel() {
  const [result, setResult] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(await invoke("probeAutomationApi", {}));
    } catch (err) {
      setError(err?.message || "Probe failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <ConfigSection title="Automation API" icon="zap">
      <p className="admin-config-row__hint" style={{ marginBottom: 10 }}>
        Automation rules are a blind spot in the findings on the Workflows tab: a status can
        look unreachable while an automation rule still transitions issues into it. This asks
        which endpoints answer rather than assuming. Rows marked <b>gateway</b> go to
        api.atlassian.com, where the documented automation API lives; <b>site</b> rows go to
        this Jira instance.
      </p>

      <button type="button" className="secondary-button" onClick={run} disabled={running}>
        <Icon name="zap" size={13} />
        {running ? "Probing…" : "Probe automation endpoints"}
      </button>

      {error && <div className="danger-zone__error" role="alert">{error}</div>}

      {result && (
        <div className="probe-results">
          {result.reachable.length > 0 ? (
            <p className="probe-results__summary probe-results__summary--ok">
              {result.reachable.length} endpoint{result.reachable.length === 1 ? "" : "s"} returned
              usable rule data. Extraction is possible.
            </p>
          ) : (
            <p className="probe-results__summary">
              No endpoint returned usable rule data. Automation rules cannot be read with the
              current scopes on this site.
            </p>
          )}
          <table className="probe-results__table">
            <thead>
              <tr><th>Scope</th><th>Via</th><th>Endpoint</th><th>Status</th><th>Response</th></tr>
            </thead>
            <tbody>
              {result.results.map((row) => (
                <tr key={row.path} className={row.ok && row.looksLikeRules ? "probe-results__row--ok" : ""}>
                  <td>{row.scope}</td>
                  <td>{row.via === "stargate" ? "gateway" : "site"}</td>
                  <td className="probe-results__path">{row.path}</td>
                  <td>{row.status === null ? "—" : row.status}</td>
                  <td className="probe-results__sample">{row.sample || "(empty)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConfigSection>
  );
}

export function AssetsProbePanel() {
  const [result, setResult] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(await invoke("probeAssetsApi", {}));
    } catch (err) {
      setError(err?.message || "Probe failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <ConfigSection title="JSM Assets API" icon="layers">
      <p className="admin-config-row__hint" style={{ marginBottom: 10 }}>
        Assets (CMDB) is a gateway API — it lives on api.atlassian.com, not this site, and
        needs JSM Premium. This confirms the workspace and which structure endpoints answer
        before an Assets pillar is built on them. <b>site</b> rows are the workspace-id
        discovery hop; <b>gateway</b> rows are the Assets API itself.
      </p>

      <button type="button" className="secondary-button" onClick={run} disabled={running}>
        <Icon name="layers" size={13} />
        {running ? "Probing…" : "Probe Assets endpoints"}
      </button>

      {error && <div className="danger-zone__error" role="alert">{error}</div>}

      {result && (
        <div className="probe-results">
          {result.assetsEnabled ? (
            <p className="probe-results__summary probe-results__summary--ok">
              Assets is reachable. Workspace <code>{result.workspaceId}</code> —{" "}
              {result.reachable.length} structure endpoint{result.reachable.length === 1 ? "" : "s"} answered.
            </p>
          ) : (
            <p className="probe-results__summary">
              {result.reason || "Assets is not reachable with the current scopes on this site."}
            </p>
          )}
          <table className="probe-results__table">
            <thead>
              <tr><th>Step</th><th>Via</th><th>Endpoint</th><th>Status</th><th>Response</th></tr>
            </thead>
            <tbody>
              {result.results.map((row) => (
                <tr key={row.path} className={row.ok && (row.looksLikeAssets ?? true) ? "probe-results__row--ok" : ""}>
                  <td>{row.step}</td>
                  <td>{row.via === "stargate" ? "gateway" : "site"}</td>
                  <td className="probe-results__path">{row.path}</td>
                  <td>{row.status === null ? "—" : row.status}</td>
                  <td className="probe-results__sample">{row.sample || "(empty)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConfigSection>
  );
}

// Global permissions: the access pillar covers PROJECT permission schemes. This probe asks
// whether the Jira Cloud REST API also exposes which groups hold each GLOBAL permission --
// as of writing it does not, and this confirms it against the live site rather than by
// assumption.
export function GlobalPermissionsProbePanel() {
  const [result, setResult] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult(await invoke("probeGlobalPermissions", {}));
    } catch (err) {
      setError(err?.message || "Probe failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <ConfigSection title="Global permissions API" icon="shield">
      <p className="admin-config-row__hint" style={{ marginBottom: 10 }}>
        The access pillar covers project permission schemes. A site-level global-permissions
        view would need an endpoint that lists which groups hold ADMINISTER, SYSTEM_ADMIN and
        the rest — this checks whether one exists on this site.
      </p>

      <button type="button" className="secondary-button" onClick={run} disabled={running}>
        <Icon name="shield" size={13} />
        {running ? "Probing…" : "Probe global-permissions API"}
      </button>

      {error && <div className="danger-zone__error" role="alert">{error}</div>}

      {result && (
        <div className="probe-results">
          <p className="probe-results__summary">
            {result.catalogAvailable
              ? `Catalog readable — ${result.globalPermissionKeys.length} global permissions defined. `
              : "The permission catalog did not answer. "}
            {result.grantEnumerationAvailable
              ? "Grant enumeration IS available — a global-permissions view can be built."
              : "No endpoint enumerates global-permission holders, so a governance view is blocked on that gap."}
          </p>
          <table className="probe-results__table">
            <thead><tr><th>Endpoint</th><th>Status</th><th>Note</th></tr></thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.path} className={row.ok ? "probe-results__row--ok" : ""}>
                  <td className="probe-results__path">{row.path}</td>
                  <td>{row.status === null ? "—" : row.status}</td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ConfigSection>
  );
}

export function ConfigTab({ config, onSave, saving }) {
// Mirrors DEFAULT_HEALTH_TOLERANCES in src/lib/health-score.js. Stored as rates; shown as
// percentages, because "flag once 15% of statuses are duplicates" is how an admin thinks
// about an estate and 0.15 is not.
const DEFAULT_TOLERANCES = {
  duplicateFieldNames: 0.10,
  fieldFindings: 0.25,
  unusedFields: 0.35,
  duplicateStatuses: 0.15,
  unreachableStatuses: 0.20,
  flaggedSchemes: 0.40,
  irregularProjects: 0.25,
  credentialRules: 0.02,
  publicShares: 0.02,
  selfTriggeringRules: 0.10,
  disabledRules: 0.50,
  externalHttpRules: 0.15,
  estateWideRules: 0.06,
  orphanIssueTypes: 0.12,
  unusedTypeSchemes: 0.40,
  duplicateIssueTypeNames: 0.15,
  brokenTypeHierarchy: 0.25,
  deactivatedLicenceHolders: 0.05,
  orphanedOwnership: 0.10,
  deadAssetSchemas: 0.20,
  bareAssetTypes: 0.30,
  brokenAssetReferences: 0.10,
  emptyAssetTypes: 0.30,
  unusedAccessSchemes: 0.35,
  fragileNotificationSchemes: 0.30,
  offRosterRoleActors: 0.05,
  duplicateResolutions: 0.15,
  duplicatePriorities: 0.20,
  boardsColumnHygiene: 0.25,
  configChurn: 0.20,
};

// Scoring model v2: dimensions with a definable good state, tuned as a { target, floor }
// band of rates rather than a single bottom-out point. Mirrors DEFAULT_HEALTH_TARGETS in
// src/lib/health-score.js; the parity test keeps the two in step.
const DEFAULT_TARGETS = {
  leastPrivilegeConformance: { target: 0.90, floor: 0.50, direction: "up" },
  boardBackingIntegrity: { target: 0.98, floor: 0.75, direction: "up" },
  schemeReuse: { target: 0.50, floor: 0.00, direction: "up" },
  securityLevelIntegrity: { target: 0.95, floor: 0.70, direction: "up" },
  adminRoleCoverage: { target: 0.95, floor: 0.60, direction: "up" },
  screenReachability: { target: 0.95, floor: 0.60, direction: "up" },
};

// Deep-merge a stored { key: { target, floor } } map over the defaults, so a config that
// only tuned one band keeps the shipped values for the rest.
function mergeTargets(stored) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_TARGETS)) {
    out[key] = { ...def, ...(stored?.[key] || {}) };
  }
  return out;
}

  const [local, setLocal] = React.useState(() => {
    const c = config || DEFAULT_CONFIG;
    return {
      ...DEFAULT_CONFIG,
      ...c,
      governanceThresholds: { ...DEFAULT_THRESHOLDS, ...(c.governanceThresholds || {}) },
      healthTolerances: { ...DEFAULT_TOLERANCES, ...(c.healthTolerances || {}) },
      healthTargets: mergeTargets(c.healthTargets),
      macroAccess: { ...DEFAULT_MACRO_ACCESS, ...(c.macroAccess || {}) },
      remediation: { ...DEFAULT_REMEDIATION, ...(c.remediation || {}) },
    };
  });
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (config) {
      setLocal({
        ...DEFAULT_CONFIG,
        ...config,
        governanceThresholds: { ...DEFAULT_THRESHOLDS, ...(config.governanceThresholds || {}) },
        healthTolerances: { ...DEFAULT_TOLERANCES, ...(config.healthTolerances || {}) },
        healthTargets: mergeTargets(config.healthTargets),
        macroAccess: { ...DEFAULT_MACRO_ACCESS, ...(config.macroAccess || {}) },
        remediation: { ...DEFAULT_REMEDIATION, ...(config.remediation || {}) },
      });
      setDirty(false);
    }
  }, [config]);

  function set(key, value) {
    setLocal((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function setThreshold(key, value) {
    setLocal((prev) => ({
      ...prev,
      governanceThresholds: { ...prev.governanceThresholds, [key]: value },
    }));
    setDirty(true);
  }

  // Takes a percentage from the input and stores a rate. Clamped to 1-100 so the value can
  // never leave this screen outside the (0, 1] band the resolver enforces on save.
  function setTolerancePercent(key, percent) {
    const rate = Math.max(1, Math.min(100, Number(percent) || 0)) / 100;
    setLocal((prev) => ({
      ...prev,
      healthTolerances: { ...prev.healthTolerances, [key]: rate },
    }));
    setDirty(true);
  }

  function setMacroAccess(key, value) {
    setLocal((prev) => ({
      ...prev,
      macroAccess: { ...(prev.macroAccess || DEFAULT_MACRO_ACCESS), [key]: value },
    }));
    setDirty(true);
  }

  // A v2 target band. `field` is "target" or "floor"; percentage in, rate stored, clamped
  // 0-100 so it cannot leave the screen outside the band the resolver accepts.
  function setTarget(key, field, percent) {
    const rate = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    setLocal((prev) => ({
      ...prev,
      healthTargets: {
        ...mergeTargets(prev.healthTargets),
        [key]: { ...mergeTargets(prev.healthTargets)[key], [field]: rate },
      },
    }));
    setDirty(true);
  }

  function setRemediation(key, value) {
    setLocal((prev) => ({
      ...prev,
      remediation: { ...(prev.remediation || DEFAULT_REMEDIATION), [key]: value },
    }));
    setDirty(true);
  }

  function handleSave() {
    onSave(local);
    setDirty(false);
  }

  const t = local.governanceThresholds || DEFAULT_THRESHOLDS;
  const hv = local.healthTolerances || DEFAULT_TOLERANCES;
  const pct = (key) => Math.round((hv[key] ?? DEFAULT_TOLERANCES[key]) * 100);
  const targets = mergeTargets(local.healthTargets);
  const targetPct = (key, field) => Math.round((targets[key]?.[field] ?? DEFAULT_TARGETS[key][field]) * 100);

  // One pane at a time, chosen from a rail, rather than five sections stacked into a
  // single scroll. The old layout put nine threshold rules between an admin and the Save
  // button they came here to press, and gave settings, records and diagnostics the same
  // visual weight -- so nothing signalled which of them could change the app's behaviour.
  const [area, setArea] = usePersistentState("observatory.section.config", "access");

  // SubNavLayout, not a bespoke rail. It already existed in admin/primitives.jsx and the
  // Scans tab already used it; building a second one here is precisely how this app came
  // to have eight parallel vocabularies for the same handful of widgets.
  return (
    <SubNavLayout items={CONFIG_AREAS} activeKey={area} onSelect={setArea}>
      <ConfigAreas
        area={area}
        local={local}
        t={t}
        set={set}
        setThreshold={setThreshold}
        setMacroAccess={setMacroAccess}
        setRemediation={setRemediation}
        pct={pct}
        setTolerancePercent={setTolerancePercent}
        targetPct={targetPct}
        setTarget={setTarget}
      />

      {/* Diagnostics change nothing, so the save bar would be noise there. */}
      {area !== "diagnostics" && (
        <StickyActions
          status={dirty ? "Unsaved changes" : "All changes saved"}
          tone={dirty ? "alert" : "neutral"}
        >
          <button
            className="primary-button"
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            <Icon name="check" size={14} />
            {saving ? "Saving…" : "Save configuration"}
          </button>
        </StickyActions>
      )}
    </SubNavLayout>
  );
}

// The four areas, in the order an admin meets them: who gets in, how hard the app works,
// what it flags, and what it can tell you about itself.
const CONFIG_AREAS = [
  { key: "access", label: "Access", icon: "lock" },
  { key: "scanning", label: "Scanning", icon: "clock" },
  { key: "rules", label: "Governance rules", icon: "alertTriangle" },
  { key: "diagnostics", label: "Diagnostics", icon: "activity" },
];

function ConfigAreas({ area, local, t, set, setThreshold, setMacroAccess, setRemediation, pct, setTolerancePercent, targetPct, setTarget }) {
  if (area === "access") {
    return (
      <>
        <PageHeader
          title="Access"
          description="The admin page is gated by Jira at the platform level and is not affected by
                 anything here. These settings govern the Confluence macro."
        />
        <AccessArea local={local} set={set} setMacroAccess={setMacroAccess} setRemediation={setRemediation} />
      </>
    );
  }

  if (area === "scanning") {
    return (
      <>
        <PageHeader
          title="Scanning"
          description="How much load Observatory puts on Jira, and how often it refreshes without
                 being asked."
        />
        <ScanningArea local={local} set={set} />
      </>
    );
  }

  if (area === "rules") {
    return (
      <>
        <PageHeader
          title="Governance rules"
          description="Every finding in the app comes from one of the rules below. Edit the numbers
                 inline — changes apply on the next inventory load, with no snapshot rebuild."
        />
        <RulesArea t={t} setThreshold={setThreshold} pct={pct} setTolerancePercent={setTolerancePercent} targetPct={targetPct} setTarget={setTarget}
          staleDays={local.automationStaleAfterDays ?? DEFAULT_AUTOMATION_STALE_AFTER_DAYS}
          setStaleDays={(v) => set("automationStaleAfterDays", v)} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Diagnostics"
        description="Records and probes. Nothing on this page changes how the app behaves — it
               reports what already happened, or asks Jira what it will answer."
      />
      <ScreenCostProbePanel />
      <AutomationProbePanel />
      <AssetsProbePanel />
      <GlobalPermissionsProbePanel />
      <AuditLogPanel />
    </>
  );
}

// Reports what a full screen inventory would cost, before one is built.
//
// The screen pipeline's cost turns on tabs-per-screen, which no amount of reasoning
// produces -- only the site can answer it. This asks, by sampling.
export function ScreenCostProbePanel() {
  const [result, setResult] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await invoke("probeScreenFetchCost", { sampleSize: 25 });
      if (res?.ok === false) {
        setError(res.hint ? `${res.error} — ${res.hint}` : res.error);
        // Keep the endpoint breakdown even on failure: on an authorization error it is
        // the only useful output, and the reason the probe ran at all.
        setResult(res.endpoints ? { endpointsOnly: true, endpoints: res.endpoints } : null);
      } else {
        setResult(res);
      }
    } catch (err) {
      setError(err?.message || "Probe failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <ConfigSection title="Screen inventory cost" icon="barChart">
      <p className="admin-config-row__hint" style={{ marginBottom: 10 }}>
        Fields-on-a-tab is one Jira call per <em>tab</em>, so the cost of a full screen
        inventory depends on how many tabs this site's screens have — a number only the site
        can answer. This samples 25 screens and extrapolates, rather than walking all of
        them, which would be the expensive thing it exists to avoid committing to.
      </p>

      <button type="button" className="secondary-button" onClick={run} disabled={running}>
        <Icon name="barChart" size={13} />
        {running ? "Measuring…" : "Measure screen fetch cost"}
      </button>

      {error && <div className="danger-zone__error" role="alert">{error}</div>}

      {result?.endpointsOnly && (
        <div className="probe-results">
          <p className="probe-results__summary">
            Which endpoints accept the app's scopes. A <b>404 is a pass</b> — it means the
            scope was accepted and only the placeholder id was wrong. Rows naming a{" "}
            <b>real id</b> were re-probed against ids that exist, so a rejection there is the
            scope and nothing else; the rows above them use a placeholder id and a 401 on
            those is ambiguous.
          </p>
          <table className="probe-results__table">
            <thead>
              <tr><th>Endpoint</th><th>Declared scope</th><th>Status</th><th>Scope accepted</th></tr>
            </thead>
            <tbody>
              {result.endpoints.map((row) => (
                <tr key={row.path} className={row.scopeAccepted ? "probe-results__row--ok" : ""}>
                  <td>{row.label}</td>
                  <td className="probe-results__path">{row.scope}</td>
                  <td>{row.status === null ? "—" : row.status}</td>
                  {/* null is not false: the endpoint was never reached, so reporting it as
                      rejected would assert a result nobody measured. */}
                  <td>{row.scopeAccepted === null ? "—" : row.scopeAccepted ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.endpoints.some((row) => row.scopeAccepted === null) && (
            <ul className="probe-results__notes">
              {result.endpoints
                .filter((row) => row.scopeAccepted === null)
                .map((row) => (
                  <li key={`note-${row.path}`}>
                    <b>{row.label}:</b> {row.sample}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {result && !result.endpointsOnly && (
        <div className="probe-results">
          {result.totalScreens === 0 ? (
            <p className="probe-results__summary">{result.note}</p>
          ) : (
            <>
              <p className={`probe-results__summary ${result.fitsOneInvocation ? "probe-results__summary--ok" : ""}`}>
                {result.fitsOneInvocation
                  ? `A full pass projects to ~${result.projectedCalls.toLocaleString()} calls and ~${result.projectedMinutes} min — inside one queue invocation.`
                  : `A full pass projects to ~${result.projectedCalls.toLocaleString()} calls and ~${result.projectedMinutes} min — too long for one invocation. Resumability is required, not optional.`}
              </p>
              <table className="probe-results__table">
                <tbody>
                  <tr><td>Screens on site</td><td>{result.totalScreens.toLocaleString()}</td></tr>
                  <tr><td>Sampled</td><td>{result.sampledScreens}</td></tr>
                  <tr><td>Tabs per screen — mean</td><td>{result.meanTabsPerScreen}</td></tr>
                  <tr><td>Tabs per screen — median</td><td>{result.medianTabsPerScreen}</td></tr>
                  {/* The tail, not the mean, is what decides whether batching is needed. */}
                  <tr><td>Tabs per screen — 90th pct</td><td>{result.p90TabsPerScreen}</td></tr>
                  <tr><td>Tabs per screen — max</td><td>{result.maxTabsPerScreen}</td></tr>
                  <tr><td>Fields per screen — mean</td><td>{result.meanFieldsPerScreen}</td></tr>
                  <tr><td>Observed ms per call</td><td>{result.msPerCall}</td></tr>
                  <tr><td>Calls made by this probe</td><td>{result.measuredCalls.toLocaleString()}</td></tr>
                  <tr><td>Rate limited (429)</td><td>{result.rateLimit.hit429}</td></tr>
                  <tr><td>Retries</td><td>{result.rateLimit.retries}</td></tr>
                  {result.failureCount > 0 && (
                    <tr><td>Reads that failed</td><td>{result.failureCount}</td></tr>
                  )}
                </tbody>
              </table>
              <p className="admin-config-row__hint">
                Projection assumes one tabs call plus one fields call per tab, at the observed
                per-call cost. The sample is random, so two runs will differ slightly — the
                figure to act on is the order of magnitude and the tail, not the exact number.
              </p>
            </>
          )}
        </div>
      )}
    </ConfigSection>
  );
}

function AccessArea({ local, set, setMacroAccess, setRemediation }) {
  return (
    <>
      <ConfigSection title="Macro access" icon="lock">
        <ConfigRow
          label="Read-only mode"
          hint="Freezes the app for everyone, admins included: no scans, inventory builds, remediation tickets or clearing data, from the macro or from this page. Turn it off to run any of them."
        >
          <Toggle checked={local.readOnlyMode} onChange={(v) => set("readOnlyMode", v)} />
        </ConfigRow>
        <ConfigRow
          label="Restrict macro to allowed groups"
          hint="When enabled, only users in the listed Jira groups can view the Observatory on any Confluence page."
        >
          <Toggle
            checked={local.macroAccess?.restrictAccess || false}
            onChange={(v) => setMacroAccess("restrictAccess", v)}
          />
        </ConfigRow>
        {local.macroAccess?.restrictAccess && (
          <ConfigRow
            label="Allowed Jira groups"
            hint="One group name per line. Users must be a member of at least one group to view the macro."
          >
            <div className="admin-group-input-wrap">
              <textarea
                className="admin-group-input"
                value={(local.macroAccess?.allowedGroups || []).join("\n")}
                onChange={(e) =>
                  setMacroAccess(
                    "allowedGroups",
                    e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)
                  )
                }
                placeholder={"jira-administrators\nfield-governance-team"}
                rows={4}
                spellCheck={false}
              />
              <p className="admin-group-input__note">
                Group names are case-sensitive. Users not in any listed group will see an "Access Restricted" message instead of the Observatory.
              </p>
            </div>
          </ConfigRow>
        )}
      </ConfigSection>

      <ConfigSection title="Remediation" icon="flag">
        <p className="admin-config-section__desc">
          Turning a governance finding into work. When set up, a finding can be pushed to
          Jira as an epic with a task per item to fix. Every ticket is created as you, in
          this project, and no ticket is created while the app is locked for changes.
        </p>
        <ConfigRow
          label="Remediation project key"
          hint="The project epics and tasks are created in — a key like OPS or ADMIN, not the project name. Leave blank to disable remediation ticketing."
        >
          <input
            type="text"
            className="ui-input"
            value={local.remediation?.projectKey || ""}
            onChange={(e) => setRemediation("projectKey", e.target.value.trim().toUpperCase())}
            placeholder="ADMIN"
            spellCheck={false}
            style={{ maxWidth: "12rem" }}
          />
        </ConfigRow>
        <ConfigRow label="Epic issue type" hint="The issue type used for the per-finding epic.">
          <input
            type="text"
            className="ui-input"
            value={local.remediation?.epicIssueType || ""}
            onChange={(e) => setRemediation("epicIssueType", e.target.value)}
            placeholder="Epic"
            spellCheck={false}
            style={{ maxWidth: "12rem" }}
          />
        </ConfigRow>
        <ConfigRow label="Task issue type" hint="The issue type used for each item to fix.">
          <input
            type="text"
            className="ui-input"
            value={local.remediation?.taskIssueType || ""}
            onChange={(e) => setRemediation("taskIssueType", e.target.value)}
            placeholder="Task"
            spellCheck={false}
            style={{ maxWidth: "12rem" }}
          />
        </ConfigRow>
        <ConfigRow
          label="Default task assignee"
          hint="Optional. An Atlassian accountId every created task is assigned to. Leave blank to create them unassigned."
        >
          <input
            type="text"
            className="ui-input"
            value={local.remediation?.defaultAssigneeAccountId || ""}
            onChange={(e) => setRemediation("defaultAssigneeAccountId", e.target.value.trim())}
            placeholder="(unassigned)"
            spellCheck={false}
            style={{ maxWidth: "22rem" }}
          />
        </ConfigRow>
      </ConfigSection>
    </>
  );
}

function ScanningArea({ local, set }) {
  return (
    <>
      <ConfigSection title="API settings" icon="sliders">
        <ConfigRow
          label="Scan concurrency"
          hint="Max parallel Jira API calls during field usage scans (1–10). Lower values reduce API load; higher values speed up scans."
        >
          <div className="admin-concurrency-control">
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={local.apiConcurrency}
              onChange={(e) => set("apiConcurrency", Number(e.target.value))}
            />
            <span className="admin-concurrency-control__value">{local.apiConcurrency}</span>
          </div>
        </ConfigRow>
      </ConfigSection>

      <ConfigSection title="Auto-snapshot" icon="clock">
        <ConfigRow
          label="Enable auto-snapshot"
          hint="Automatically rebuilds the field snapshot on a schedule. A daily Forge trigger checks whether a rebuild is due."
        >
          <Toggle checked={local.autoSnapshotEnabled} onChange={(v) => set("autoSnapshotEnabled", v)} />
        </ConfigRow>
        {local.autoSnapshotEnabled && (
          <ConfigRow label="Frequency" hint="How often the snapshot should be automatically rebuilt.">
            <select
              value={local.autoSnapshotFrequency}
              onChange={(e) => set("autoSnapshotFrequency", e.target.value)}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </ConfigRow>
        )}
      </ConfigSection>
    </>
  );
}

// Grouped by what the finding means, not listed flat. Nine rules in one undifferentiated
// column reads as a wall; the same nine under three headings read as three decisions.
function RulesArea({ t, setThreshold, pct, setTolerancePercent, targetPct, setTarget, staleDays, setStaleDays }) {
  return (
    <>
      <ConfigSection title="Scoring targets" icon="sliders">
        <p className="admin-config-section__desc">
          Dimensions with a definable good state, tuned as a band. The dimension scores 100
          at or past the <strong>target</strong>, 0 at or past the <strong>floor</strong>,
          and its weight in the roll-up scales with how much of the estate it affects. A
          small bonus or penalty is folded in for whether the number moved the right way
          since the last scan.
        </p>
        <div className="admin-threshold-rules">
          <TargetRule tone="risk" badge="Permissions" name="Least-privilege conformance"
            targetPct={targetPct} setTarget={setTarget} k="leastPrivilegeConformance"
            tail="of permission schemes with no anyone-browse, no group-level project admin and no named individuals." />
          <TargetRule tone="risky" badge="Boards" name="Board backing integrity"
            targetPct={targetPct} setTarget={setTarget} k="boardBackingIntegrity"
            tail="of boards running on a live, owned backing filter." />
          <TargetRule tone="standardize" badge="Workflow" name="Scheme reuse"
            targetPct={targetPct} setTarget={setTarget} k="schemeReuse"
            tail="of workflow schemes governing more than one project — there is nothing to standardise against below this." />
          <TargetRule tone="risk" badge="Issue security" name="Security level integrity"
            targetPct={targetPct} setTarget={setTarget} k="securityLevelIntegrity"
            tail="of issue-security levels that have members and belong to a scheme with levels." />
          <TargetRule tone="risk" badge="Roles" name="Admin role coverage"
            targetPct={targetPct} setTarget={setTarget} k="adminRoleCoverage"
            tail="of projects with roles that have a populated, group-based administrator role — the rest can only be managed by a site admin." />
          <TargetRule tone="standardize" badge="Screens" name="Screen reachability"
            targetPct={targetPct} setTarget={setTarget} k="screenReachability"
            tail="of readable screens a user can arrive at through a scheme or a transition." />
        </div>
      </ConfigSection>

      <ConfigSection title="Risk" icon="alertTriangle">
        <p className="admin-config-section__desc">
          Fields where a change or a removal carries consequences. These raise attention, not
          cleanup — a field flagged here is usually one to leave alone.
        </p>
        <div className="admin-threshold-rules">

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--risk">Risk</span>
            <span className="admin-threshold-rule__sentence">
              <strong>High-impact field:</strong> Flag when active in at least{" "}
              <InlineThresholdInput value={t.highImpactMinProjects} onChange={(v) => setThreshold("highImpactMinProjects", v)} min={1} max={500} />{" "}
              projects with{" "}
              <InlineThresholdInput value={t.highImpactMinIssues} onChange={(v) => setThreshold("highImpactMinIssues", v)} min={1} max={1000000} />{" "}
              or more issues — high stakes if changed or removed.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--risk">Risk</span>
            <span className="admin-threshold-rule__sentence">
              <strong>App-provided field:</strong> Flag third-party app or plugin fields when they have{" "}
              <InlineThresholdInput value={t.appFieldHeavyUsageMin} onChange={(v) => setThreshold("appFieldHeavyUsageMin", v)} min={1} max={100000} />{" "}
              or more issues — data at risk if the app is removed.
            </span>
          </div>

        </div>
      </ConfigSection>

      <ConfigSection title="Cleanup" icon="scissors">
        <p className="admin-config-section__desc">
          Fields that cost something and return little. The largest group, and the one where
          thresholds matter most — set them too loose and every field on the site is flagged.
        </p>
        <div className="admin-threshold-rules">

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Broadly scoped, light usage:</strong> Flag when active in{" "}
              <InlineThresholdInput value={t.lightUsageMinProjects} onChange={(v) => setThreshold("lightUsageMinProjects", v)} min={1} max={500} />{" "}
              or more projects but fewer than{" "}
              <InlineThresholdInput value={t.lightUsageMaxIssues} onChange={(v) => setThreshold("lightUsageMaxIssues", v)} min={1} max={10000} />{" "}
              total issues — wide scope, very little actual data.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              {/*
                Was "added to N or more project screens". It is not screens -- the rule reads
                broadScopeMinProjects, which counts projects a field's CONTEXT applies to.
                Observatory holds no screen data today, so the sentence described evidence
                that was never gathered. Reworded to what the rule actually measures.

                When the screen inventory ships this becomes a real choice: keep it as
                contexts, or repoint the rule at screen reachability, which would make it a
                materially stronger finding. Either way the words and the rule must agree --
                see ConfigTab.test.jsx, which now asserts exactly that.
              */}
              <strong>Configured but unused:</strong> Flag when a field's context covers{" "}
              <InlineThresholdInput value={t.broadScopeMinProjects} onChange={(v) => setThreshold("broadScopeMinProjects", v)} min={1} max={500} />{" "}
              or more projects but no issue anywhere has a value — likely never adopted.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Dead configuration:</strong> Flag when configured in{" "}
              <InlineThresholdInput value={t.configuredActiveGapMinProjects} onChange={(v) => setThreshold("configuredActiveGapMinProjects", v)} min={1} max={500} />{" "}
              or more projects but more than{" "}
              <InlineThresholdInput value={Math.round(t.configuredActiveGapMaxRatio * 100)} onChange={(v) => setThreshold("configuredActiveGapMaxRatio", Math.max(5, Math.min(99, v)) / 100)} min={5} max={99} />{" "}
              % of those have no issue data — the field was added but not used.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Over-scoped global context:</strong> Flag fields available to all projects (global context) when they have fewer than{" "}
              <InlineThresholdInput value={t.globalContextMaxIssues} onChange={(v) => setThreshold("globalContextMaxIssues", v)} min={1} max={100000} />{" "}
              issues — probably not worth applying site-wide.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--cleanup">Cleanup</span>
            <span className="admin-threshold-rule__sentence">
              <strong>No recent activity:</strong> Flag fields that have issue data but whose most recent recorded change is older than{" "}
              <InlineThresholdInput value={t.staleFieldMaxAgeDays} onChange={(v) => setThreshold("staleFieldMaxAgeDays", v)} min={30} max={3650} />{" "}
              days — the data is historical. Only applies to fields whose per-project usage was built with changelog dates.
            </span>
          </div>

        </div>
      </ConfigSection>

      <ConfigSection title="Standardize" icon="layers">
        <p className="admin-config-section__desc">
          Fields that make the catalog harder to maintain without being wrong in themselves.
          The lowest-urgency group, and the one most worth tuning to your site's size.
        </p>
        <div className="admin-threshold-rules">

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--standardize">Standardize</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Missing description:</strong> Flag when a field has no admin description and is active in{" "}
              <InlineThresholdInput value={t.missingDescriptionMinProjects} onChange={(v) => setThreshold("missingDescriptionMinProjects", v)} min={1} max={500} />{" "}
              or more projects, or has{" "}
              <InlineThresholdInput value={t.missingDescriptionMinIssues} onChange={(v) => setThreshold("missingDescriptionMinIssues", v)} min={1} max={1000000} />{" "}
              or more issues — prominent enough to need documentation.
            </span>
          </div>

          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--standardize">Standardize</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Context sprawl:</strong> Flag when a field has{" "}
              <InlineThresholdInput value={t.contextSprawlMinContexts} onChange={(v) => setThreshold("contextSprawlMinContexts", v)} min={2} max={100} />{" "}
              or more separate project contexts — suggests it was added project-by-project and should be consolidated.
            </span>
          </div>

        </div>
        <p className="admin-threshold-rules__note">
          <strong>Admin Attention</strong> is applied automatically to any field with a high-severity finding, or when the combined priority score of its findings reaches 35 or higher.
        </p>
      </ConfigSection>

      <ConfigSection title="Workflows &amp; statuses" icon="activity">
        <p className="admin-config-section__desc">
          These score the status catalogue and the schemes that reach it. Unlike the field rules
          above they are a share of the estate rather than a raw count &mdash; a site with 400 statuses
          and 20 duplicates is tidier than one with 60 statuses and 20 duplicates, and scoring counts
          would rank them the wrong way round.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="cleanup" badge="Workflow" name="Duplicate statuses" pct={pct} set={setTolerancePercent} k="duplicateStatuses"
            tail="of statuses duplicating another." />
          <ToleranceRule tone="cleanup" badge="Workflow" name="Unreachable statuses" pct={pct} set={setTolerancePercent} k="unreachableStatuses"
            tail="of statuses that no transition can reach." />
          <ToleranceRule tone="cleanup" badge="Workflow" name="Rule-only statuses" pct={pct} set={setTolerancePercent} k="ruleOnlyStatuses"
            tail="of statuses reached only by an automation rule, never by a person." />
          <ToleranceRule tone="standardize" badge="Workflow" name="Scheme balance" pct={pct} set={setTolerancePercent} k="flaggedSchemes"
            tail="of workflow schemes carrying a structural finding." />
        </div>
      </ConfigSection>

      <ConfigSection title="Saved filters" icon="search">
        <p className="admin-config-section__desc">
          A saved filter is the one piece of Jira configuration that fails silently in both
          directions &mdash; it can return the wrong answer for months without anyone noticing, and it
          takes every board and dashboard built on it when it goes. Four rules, tuned separately,
          because the four failures are not equally serious.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="risk" badge="Filter" name="Orphaned filters" pct={pct} set={setTolerancePercent} k="orphanedFilters"
            tail="of filters with no live owner. Jira deletes a filter along with its owner, so these are on a timer." />
          <ToleranceRule tone="cleanup" badge="Filter" name="Shared with everyone" pct={pct} set={setTolerancePercent} k="overSharedFilters"
            tail="of filters visible to every logged-in user." />
          <ToleranceRule tone="cleanup" badge="Filter" name="Shared publicly" pct={pct} set={setTolerancePercent} k="publicShares"
            tail="of filters, and separately of dashboards, shared globally -- readable by anonymous visitors on a site that allows public access." />
          <ToleranceRule tone="cleanup" badge="Filter" name="Subscribed but unread" pct={pct} set={setTolerancePercent} k="zombieSubscriptions"
            tail="of filters emailing a search nobody opens." />
          <ToleranceRule tone="risk" badge="Filter" name="Broken scope" pct={pct} set={setTolerancePercent} k="brokenFilterScope"
            tail="of filters naming a project that does not exist." />
        </div>
      </ConfigSection>

      <ConfigSection title="Dashboards" icon="barChart">
        <p className="admin-config-section__desc">
          Looser bounds than the filter rules throughout, deliberately: a dashboard breaking is
          visible the moment somebody opens it, where a filter is wrong in silence.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="risk" badge="Dashboard" name="Orphaned dashboards" pct={pct} set={setTolerancePercent} k="orphanedDashboards"
            tail="of dashboards with no live owner. A wall-screen dashboard owned by somebody who left has a deletion date nobody has written down." />
          <ToleranceRule tone="cleanup" badge="Dashboard" name="Editable by everyone" pct={pct} set={setTolerancePercent} k="editableDashboards"
            tail="of dashboards any logged-in user can rearrange, without the owner being told." />
          <ToleranceRule tone="standardize" badge="Dashboard" name="Shared but unfavourited" pct={pct} set={setTolerancePercent} k="unusedDashboards"
            tail="of shared dashboards nobody has favourited. Favourites are the closest signal Jira gives to use — this bounds a claim about neglect rather than proving one." />
          <ToleranceRule tone="cleanup" badge="Dashboard" name="Empty dashboards" pct={pct} set={setTolerancePercent} k="emptyDashboards"
            tail="of dashboards carrying no gadgets at all. Scored only when the gadget walk completed." />
        </div>
      </ConfigSection>

      <ConfigSection title="Screens" icon="layout">
        <p className="admin-config-section__desc">
          A scheme pointing at a screen that no longer exists does not error &mdash; Jira falls back
          silently, so the form a user sees is not the one the scheme names. Nobody finds these by
          using Jira.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="risk" badge="Screen" name="Dangling scheme operations" pct={pct} set={setTolerancePercent} k="danglingScreenRefs"
            tail="of scheme operations pointing at a screen that no longer exists." />
          <ToleranceRule tone="cleanup" badge="Screen" name="Unreachable screens" pct={pct} set={setTolerancePercent} k="unusedScreens"
            tail="of screens no scheme and no transition can reach." />
          <ToleranceRule tone="risk" badge="Risk" name="Invisible data" pct={pct} set={setTolerancePercent} k="invisibleData"
            tail={"of populated fields holding values in projects whose screens do not show them. Something outside the UI writes these, so they are harder to remove safely, not easier."} />
          <ToleranceRule tone="cleanup" badge="Screen" name="Form clutter" pct={pct} set={setTolerancePercent} k="formClutter"
            tail="of create-screen placements that nobody in that project ever fills in. Create is the one form nobody can skip." />
        </div>
      </ConfigSection>

      <ConfigSection title="Issue types" icon="layers">
        <p className="admin-config-section__desc">
          What an issue can be, and which projects can create it. A type on no scheme cannot be
          created anywhere; a scheme on no project is a decision nobody made.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="risk" badge="Issue type" name="Orphan issue types" pct={pct} set={setTolerancePercent} k="orphanIssueTypes"
            tail="of issue types on no scheme — nothing can create one, so every one is clutter in every type picker." />
          <ToleranceRule tone="cleanup" badge="Issue type" name="Unassigned type schemes" pct={pct} set={setTolerancePercent} k="unusedTypeSchemes"
            tail="of issue type schemes assigned to no project." />
          <ToleranceRule tone="standardize" badge="Issue type" name="Duplicate type names" pct={pct} set={setTolerancePercent} k="duplicateIssueTypeNames"
            tail="of issue types duplicating another's name. A Bug / Defect split makes every by-type report wrong." />
          <ToleranceRule tone="risk" badge="Issue type" name="Broken type hierarchy" pct={pct} set={setTolerancePercent} k="brokenTypeHierarchy"
            tail="of schemes with only sub-tasks, or an uncreatable default type — an issue cannot be started." />
        </div>
      </ConfigSection>

      <ConfigSection title="People" icon="user">
        <p className="admin-config-section__desc">
          Licence waste and orphaned ownership. A deactivated account in an access group is a
          seat being paid for; a filter or dashboard whose owner is gone breaks the moment Jira
          purges the account.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="risk" badge="People" name="Deactivated licence holders" pct={pct} set={setTolerancePercent} k="deactivatedLicenceHolders"
            tail="of licensed accounts that Jira has deactivated — a paid seat and a login that should not exist." />
          <ToleranceRule tone="risk" badge="People" name="Orphaned ownership" pct={pct} set={setTolerancePercent} k="orphanedOwnership"
            tail="of owned filters, dashboards and rules whose owner is not in the licensed roster." />
          <ToleranceRule tone="cleanup" badge="People" name="Dormant licences" pct={pct} set={setTolerancePercent} k="dormantLicences"
            tail={"of measured accounts holding a seat with no issue activity in a year. Scored against accounts the crawl actually reached, never the whole roster — an account nobody counted is not an idle one."} />
        </div>
      </ConfigSection>

      <ConfigSection title="Assets (CMDB)" icon="database">
        <p className="admin-config-section__desc">
          The JSM Assets structure. Only scored on a Jira Service Management Premium site &mdash;
          everywhere else the pillar reports itself not applicable.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="cleanup" badge="Assets" name="Dead object schemas" pct={pct} set={setTolerancePercent} k="deadAssetSchemas"
            tail="of object schemas with no object types or no objects — a namespace that resolves to nothing." />
          <ToleranceRule tone="standardize" badge="Assets" name="Bare object types" pct={pct} set={setTolerancePercent} k="bareAssetTypes"
            tail="of concrete object types carrying no attribute beyond the built-in Name." />
          <ToleranceRule tone="risk" badge="Assets" name="Broken references" pct={pct} set={setTolerancePercent} k="brokenAssetReferences"
            tail="of object-reference attributes pointing at an object type that is gone." />
          <ToleranceRule tone="standardize" badge="Assets" name="Empty object types" pct={pct} set={setTolerancePercent} k="emptyAssetTypes"
            tail={"of measured object types that have never had an object created against them. Scored against the types the object-count crawl actually reached, never every concrete type — an unmeasured type is not an empty one."} />
        </div>
      </ConfigSection>

      <ConfigSection title="Access schemes" icon="shield">
        <p className="admin-config-section__desc">
          Permission, issue-security and notification schemes. Least privilege carries the most
          consequence &mdash; a scheme that opens browse to anyone is a data-exposure fact, not a
          tidiness one &mdash; so it is bounded tightest; unused schemes of any kind are the most
          forgiving.
        </p>
        <div className="admin-threshold-rules">
          {/* Least-privilege and security-level integrity moved to the Scoring targets
              section — both have a good state (a conformance / integrity rate) to converge
              on, not just a bad rate to stay under. */}
          <ToleranceRule tone="standardize" badge="Notifications" name="Fragile routing" pct={pct} set={setTolerancePercent} k="fragileNotificationSchemes"
            tail="of notification schemes sending an event to a named individual rather than a role or group." />
          <ToleranceRule tone="cleanup" badge="Access" name="Unused schemes" pct={pct} set={setTolerancePercent} k="unusedAccessSchemes"
            tail="of permission, security and notification schemes assigned to no project." />
          {/* Empty admin roles moved to Scoring targets as "Admin role coverage" — the
              share of projects with a manageable admin role is the good state to hold. */}
          <ToleranceRule tone="cleanup" badge="Roles" name="Off-roster role actors" pct={pct} set={setTolerancePercent} k="offRosterRoleActors"
            tail="of project-role user actors that are accounts no longer on the licensed roster." />
        </div>
      </ConfigSection>

      <ConfigSection title="Priorities &amp; resolutions" icon="flag">
        <p className="admin-config-section__desc">
          The two global value lists Jira offers no scheme layer to contain. A duplicated
          resolution silently splits every resolution-based report, so it is bounded tighter
          than priorities, which duplicate less often and matter less when they do.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="standardize" badge="Resolutions" name="Duplicate resolution names" pct={pct} set={setTolerancePercent} k="duplicateResolutions"
            tail="of the resolution list duplicating another entry &mdash; a Done / Fixed / Complete split makes every resolution report wrong." />
          <ToleranceRule tone="standardize" badge="Priorities" name="Duplicate priority names" pct={pct} set={setTolerancePercent} k="duplicatePriorities"
            tail="of the priority list duplicating another entry." />
        </div>
      </ConfigSection>

      <ConfigSection title="Configuration drift" icon="clock">
        <p className="admin-config-section__desc">
          Not a defect rate &mdash; structural change is neither good nor bad on its own. This
          scores a rate of motion: what share of the tracked estate changed in the trailing 30
          days. It exists to flag the outlier pass, not the ordinary maintenance one.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="cleanup" badge="Drift" name="Configuration churn" pct={pct} set={setTolerancePercent} k="configChurn"
            tail="of tracked configuration entities changed in the trailing 30 days." />
        </div>
      </ConfigSection>

      <ConfigSection title="Boards" icon="activity">
        <p className="admin-config-section__desc">
          Agile boards break silently. A board on a deleted or absent backing filter shows
          every issue in the site, so it is bounded tight; a column that maps no status or a
          removed one drops issues off the wall, which is bad but less immediate.
        </p>
        <div className="admin-threshold-rules">
          {/* Broken backing filters moved to the Scoring targets section — a board on a live
              filter is the good state to hold at, weighted by what depends on it. */}
          <ToleranceRule tone="cleanup" badge="Boards" name="Column hygiene" pct={pct} set={setTolerancePercent} k="boardsColumnHygiene"
            tail="of boards with a column that maps no status, or one that has been deleted." />
        </div>
      </ConfigSection>

      <ConfigSection title="Automation" icon="refreshCw">
        <p className="admin-config-section__desc">
          Fed by a rule export rather than a scan &mdash; Jira publishes no API to enumerate automation
          rules, so these score whatever was last imported on the Automation tab.
        </p>
        <div className="admin-threshold-rules">
          {/* Not a tolerance: this one is days, and it gates whether an answer is given at
              all rather than how a rate is scored. Deliberately not passed as k= so the
              tolerance/target parity test keeps comparing only the rules that feed the score. */}
          <div className="admin-threshold-rule">
            <span className="admin-threshold-rule__badge admin-threshold-rule__badge--risk">Evidence</span>
            <span className="admin-threshold-rule__sentence">
              <strong>Analysis staleness:</strong> stop treating the imported analysis as current after{" "}
              <InlineThresholdInput
                value={staleDays}
                onChange={setStaleDays}
                min={1}
                max={90}
              />{" "}
              days. Past that, &ldquo;no rule touches this&rdquo; degrades to <em>unknown</em> rather than
              being reported as safe to delete &mdash; because a rule written since the last import is
              not in it.
            </span>
          </div>
          <ToleranceRule tone="risk" badge="Risk" name="Credentials in rules" pct={pct} set={setTolerancePercent} k="credentialRules"
            tail="of rules carrying a secret in plaintext. The highest-consequence thing this app finds anywhere." />
          <ToleranceRule tone="cleanup" badge="Automation" name="Self-triggering rules" pct={pct} set={setTolerancePercent} k="selfTriggeringRules"
            tail="of rules that can re-trigger themselves." />
          <ToleranceRule tone="cleanup" badge="Automation" name="Disabled rules" pct={pct} set={setTolerancePercent} k="disabledRules"
            tail="of rules left switched off." />
          <ToleranceRule tone="cleanup" badge="Automation" name="Outbound HTTP" pct={pct} set={setTolerancePercent} k="externalHttpRules"
            tail="of rules calling an external service." />
          <ToleranceRule tone="risk" badge="Risk" name="Estate-wide blast radius" pct={pct} set={setTolerancePercent} k="estateWideRules"
            tail="of rules that can move every project at once. One misfire or one compromised author reaches the whole site." />
        </div>
      </ConfigSection>

      <ConfigSection title="Projects" icon="folder">
        <p className="admin-config-section__desc">
          Shares of the estate, not counts. Adoption needs issue creation dates, which only a
          Universal Scan collects &mdash; until one has run that rule reports unmeasured rather than zero.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="standardize" badge="Project" name="Irregular projects" pct={pct} set={setTolerancePercent} k="irregularProjects"
            tail="of projects carrying far more fields than the site median." />
          <ToleranceRule tone="cleanup" badge="Project" name="Inactive projects" pct={pct} set={setTolerancePercent} k="inactiveProjects"
            tail="of projects that carry fields but no recorded work at all." />
          <ToleranceRule tone="standardize" badge="Project" name="Unadopted projects" pct={pct} set={setTolerancePercent} k="unadoptedProjects"
            tail="of projects running well below their own historical rate, or that never took off." />
        </div>
      </ConfigSection>

      <ConfigSection title="Field rates" icon="layers">
        <p className="admin-config-section__desc">
          The two field rules scored as a share of the catalogue, rather than per field like the
          thresholds above.
        </p>
        <div className="admin-threshold-rules">
          <ToleranceRule tone="cleanup" badge="Field" name="Field findings" pct={pct} set={setTolerancePercent} k="fieldFindings"
            tail="of the catalogue carrying a high or medium severity finding, weighted." />
          <ToleranceRule tone="standardize" badge="Field" name="Duplicate field names" pct={pct} set={setTolerancePercent} k="duplicateFieldNames"
            tail="of fields sharing a name with another." />
        </div>
      </ConfigSection>

      <p className="admin-threshold-rules__note">
        Every rule above feeds the site health score. A category&rsquo;s share of that score is fixed by
        what the category is worth, not by how many rules it contains &mdash; so tuning a rule here
        changes how strictly that one thing is judged, and never how much the category counts.
      </p>
    </>
  );
}

// One tolerance rule: a sentence with the bound in the middle of it.
//
// Twenty-five of these are rendered, and hand-writing the markup twenty-five times is how the
// page ended up with nine rules on it while fourteen more tolerances quietly drove the score
// with no control at all. A rule that is one line to add is a rule that gets added.
function ToleranceRule({ tone, badge, name, pct, set, k, tail }) {
  return (
    <div className="admin-threshold-rule">
      <span className={`admin-threshold-rule__badge admin-threshold-rule__badge--${tone}`}>{badge}</span>
      <span className="admin-threshold-rule__sentence">
        <strong>{name}:</strong> score bottoms out at{" "}
        <InlineThresholdInput value={pct(k)} onChange={(v) => set(k, v)} min={1} max={100} />{" "}
        % {tail}
      </span>
    </div>
  );
}

// A v2 target band: score 100 at the target, 0 at the floor.
function TargetRule({ tone, badge, name, targetPct, setTarget, k, tail }) {
  return (
    <div className="admin-threshold-rule">
      <span className={`admin-threshold-rule__badge admin-threshold-rule__badge--${tone}`}>{badge}</span>
      <span className="admin-threshold-rule__sentence">
        <strong>{name}:</strong> scores 100 at{" "}
        <InlineThresholdInput value={targetPct(k, "target")} onChange={(v) => setTarget(k, "target", v)} min={0} max={100} />{" "}
        %, 0 at{" "}
        <InlineThresholdInput value={targetPct(k, "floor")} onChange={(v) => setTarget(k, "floor", v)} min={0} max={100} />{" "}
        % {tail}
      </span>
    </div>
  );
}
