import React from "react";
import { AuditLogPanel } from "../components/admin/AuditLogPanel";
import { invoke, view } from "@forge/bridge";
import { Icon } from "../components/Icons";
import { DEFAULT_THRESHOLDS, DEFAULT_MACRO_ACCESS, DEFAULT_CONFIG } from "../admin-defaults";
import { Toggle, ConfigSection, ConfigRow, InlineThresholdInput } from "../components/admin/primitives";

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
        look unreachable while an automation rule still transitions issues into it. Jira&apos;s
        automation API has historically been undocumented, so this asks which endpoints answer
        on this site rather than assuming.
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
              <tr><th>Scope</th><th>Endpoint</th><th>Status</th><th>Response</th></tr>
            </thead>
            <tbody>
              {result.results.map((row) => (
                <tr key={row.path} className={row.ok && row.looksLikeRules ? "probe-results__row--ok" : ""}>
                  <td>{row.scope}</td>
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

export function ConfigTab({ config, onSave, saving }) {
  const [local, setLocal] = React.useState(() => {
    const c = config || DEFAULT_CONFIG;
    return {
      ...DEFAULT_CONFIG,
      ...c,
      governanceThresholds: { ...DEFAULT_THRESHOLDS, ...(c.governanceThresholds || {}) },
      macroAccess: { ...DEFAULT_MACRO_ACCESS, ...(c.macroAccess || {}) },
    };
  });
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (config) {
      setLocal({
        ...DEFAULT_CONFIG,
        ...config,
        governanceThresholds: { ...DEFAULT_THRESHOLDS, ...(config.governanceThresholds || {}) },
        macroAccess: { ...DEFAULT_MACRO_ACCESS, ...(config.macroAccess || {}) },
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

  function setMacroAccess(key, value) {
    setLocal((prev) => ({
      ...prev,
      macroAccess: { ...(prev.macroAccess || DEFAULT_MACRO_ACCESS), [key]: value },
    }));
    setDirty(true);
  }

  function handleSave() {
    onSave(local);
    setDirty(false);
  }

  const t = local.governanceThresholds || DEFAULT_THRESHOLDS;

  return (
    <div className="admin-config-tab">
      <ConfigSection title="Macro access" icon="lock">
        <ConfigRow
          label="Read-only mode"
          hint="Prevents Confluence macro users from triggering field usage scans. Admins can still run jobs here."
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

      <ConfigSection title="Governance thresholds" icon="alertTriangle">
        <p className="admin-config-section__desc">
          Each rule below controls one specific finding. Edit the numbers inline — changes apply on the next inventory load with no snapshot rebuild required.
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
              <strong>Configured but unused:</strong> Flag when added to{" "}
              <InlineThresholdInput value={t.broadScopeMinProjects} onChange={(v) => setThreshold("broadScopeMinProjects", v)} min={1} max={500} />{" "}
              or more project screens but has zero issues with a value — likely never adopted.
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

      <div className="admin-config-footer">
        {dirty && <span className="admin-config-footer__unsaved">Unsaved changes</span>}
        <button
          className="primary-button"
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          <Icon name="check" size={14} />
          {saving ? "Saving…" : "Save configuration"}
        </button>
      </div>

      {/* Below the save footer deliberately: this is a record, not a setting, and it
          should not sit between an admin and the button they came here to press. */}
      <AutomationProbePanel />
      <AuditLogPanel />
    </div>
  );
}
