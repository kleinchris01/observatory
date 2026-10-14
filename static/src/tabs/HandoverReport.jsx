import React from "react";
import { invoke } from "@forge/bridge";
import { Chip, JiraLink, EmptyState } from "../components/ui";
import { formatNumber, buildJiraSearchUrl, buildProjectUrl, buildBoardUrl } from "../utils";

// The handover report for one person, on their People row: what depends on their account,
// ordered by what happens when it is removed. Built by getHandoverReport (src/lib/handover.js).
// Loaded on request rather than with the row: it reads every project's lead from Jira, which
// is worth a second only when someone is actually leaving.

const STATUS = {
  action: (count) => ({ tone: "warning", label: formatNumber(count) }),
  clear: () => ({ tone: "success", label: "Nothing" }),
  unmeasured: () => ({ tone: "neutral", label: "Not measured" }),
};

function itemHref(item, siteOrigin) {
  if (item.url) return item.url;
  if (!siteOrigin) return null;
  if (item.jql) return buildJiraSearchUrl(siteOrigin, item.jql);
  if (item.kind === "project" && item.projectKey) return buildProjectUrl(siteOrigin, item.projectKey);
  if (item.kind === "board" && item.projectKey) return buildBoardUrl(siteOrigin, item.projectKey, item.id);
  return null;
}

function HandoverSection({ section, siteOrigin }) {
  const status = (STATUS[section.status] || STATUS.unmeasured)(section.count);
  return (
    <section className="handover-section">
      <h4 className="ui-subhead">
        {section.title} <Chip tone={status.tone}>{status.label}</Chip>
      </h4>
      <p className="handover-section__why">{section.why}</p>
      {section.status === "unmeasured" ? (
        <p className="admin-config-row__hint">{section.reason}</p>
      ) : section.items.length ? (
        <>
          <p className="handover-section__action">{section.action}</p>
          <ul className="people-owned-list">
            {section.items.map((item) => {
              const href = itemHref(item, siteOrigin);
              return (
                <li key={`${item.kind}-${item.id}`}>
                  {href ? <JiraLink href={href} title={`Open ${item.name} in Jira`}>{item.name}</JiraLink> : item.name}
                  <span className="handover-section__detail"> · {item.detail}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {section.status !== "unmeasured" && section.reason && <p className="admin-config-row__hint">{section.reason}</p>}
    </section>
  );
}

export function HandoverReport({ accountId, siteOrigin = "", load = invoke }) {
  const [state, setState] = React.useState({ status: "idle", report: null, error: null });

  async function prepare() {
    setState({ status: "loading", report: null, error: null });
    try {
      const report = await load("getHandoverReport", { accountId });
      setState({ status: "ready", report, error: null });
    } catch (err) {
      setState({ status: "error", report: null, error: err?.message || "The handover report could not be prepared." });
    }
  }

  if (state.status === "idle" || state.status === "error") {
    return (
      <div className="handover">
        <button type="button" className="secondary-button" onClick={prepare}>Prepare handover report</button>
        <span className="admin-config-row__hint"> What breaks or needs a new owner if this account is removed.</span>
        {state.error && <div className="danger-zone__error" role="alert">{state.error}</div>}
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className="handover"><p className="admin-config-row__hint">Preparing the handover report…</p></div>;
  }

  const { report } = state;
  if (!report?.available) {
    return (
      <div className="handover">
        <EmptyState inline>Build the people roster (or run a full scan) to prepare a handover report.</EmptyState>
      </div>
    );
  }
  return (
    <div className="handover">
      <div className="handover__head">
        <h4 className="ui-subhead">Handover report for {report.person.displayName}</h4>
        <p className="handover__summary">{report.summary}</p>
        {report.beforeRemoval > 0 && (
          <p className="admin-config-row__hint">
            {formatNumber(report.beforeRemoval)} item{report.beforeRemoval === 1 ? "" : "s"} to deal with before the account is removed.
          </p>
        )}
      </div>
      {report.sections.map((section) => (
        <HandoverSection key={section.key} section={section} siteOrigin={siteOrigin} />
      ))}
    </div>
  );
}
