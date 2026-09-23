import React from "react";
import { invoke } from "@forge/bridge";
import { Icon } from "../Icons";
import { Panel, LinkButton } from "../ui";
import { formatNumber, formatRelativeTime } from "../../utils";

// First run.
//
// This app is useless for the first few hours of its life -- nothing it says is worth reading
// until a scan has walked the estate, and on a real site that is a multi-hour job. So this
// panel is not a product tour. It has two jobs: tell an admin the four things that actually
// need doing, and turn the wait for the first scan into something worth watching.
//
// The arrivals list is the half that matters. Fifteen scan stages become fifteen small
// moments, each one a section the admin can open NOW while the issue crawl runs for another
// two hours. The data was already there; nothing surfaced it as arrival.

function StepIcon({ done, kind }) {
  if (done) {
    return (
      <span className="first-run__tick first-run__tick--done" aria-hidden="true">
        <Icon name="checkCircle" size={15} />
      </span>
    );
  }
  return <span className={`first-run__tick first-run__tick--${kind}`} aria-hidden="true" />;
}

export function FirstRunStep({ step, onAcknowledge, onNavigate, busy }) {
  return (
    <li className={`first-run__step${step.done ? " first-run__step--done" : ""}`}>
      <StepIcon done={step.done} kind={step.kind} />
      <div className="first-run__step-body">
        <p className="first-run__step-title">{step.title}</p>
        <p className="first-run__step-detail">{step.detail}</p>

        <div className="first-run__step-actions">
          {step.cta && !step.done && (
            <LinkButton onClick={() => onNavigate(step.cta.tab)}>{step.cta.label}</LinkButton>
          )}
          {/* Only the two steps that describe a human having READ something can be ticked by
              hand. A derived step reports the estate, and the estate is the only thing
              entitled to answer -- a "mark done" there would be a tick meaning "somebody
              clicked" wearing the appearance of "this is true". */}
          {step.kind === "acknowledged" && !step.done && (
            <button
              type="button"
              className="secondary-button secondary-button--small"
              onClick={() => onAcknowledge(step.key)}
              disabled={busy}
            >
              Got it
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// What has landed, and what is still coming.
export function ArrivalsList({ arrivals, onNavigate }) {
  if (!arrivals?.available) return null;
  const { landed = [], pending = [] } = arrivals;
  if (!landed.length && !pending.length) return null;

  // Stage keys map to tabs by name in most cases; the handful that do not are listed here
  // rather than guessed at, because a dead link in a welcome panel is worse than no link.
  const TAB_FOR_STAGE = {
    workflows: "workflows", screens: "screens", filters: "filters", dashboards: "dashboards",
    fields: "fields", "issue-types": "issueTypes", access: "access", estate: "priorities",
    boards: "boards", people: "people", assets: "assets", drift: "changes",
  };

  return (
    <div className="first-run__arrivals">
      <p className="first-run__arrivals-head">
        {landed.length > 0
          ? `${formatNumber(landed.length)} of ${formatNumber(landed.length + pending.length)} sections have landed`
          : "Nothing has landed yet"}
      </p>

      <ul className="first-run__arrival-list">
        {landed.slice(0, 8).map((stage) => {
          const tab = TAB_FOR_STAGE[stage.key];
          return (
            <li className="first-run__arrival" key={stage.key}>
              <span className="first-run__arrival-dot" aria-hidden="true" />
              <span className="first-run__arrival-label">
                <strong>{stage.label}</strong>
                {/* Not every stage counts something -- health records a score, drift appends
                    to a timeline. "Produced --" on those reads as a failure rather than as a
                    stage that simply has nothing to count. */}
                {stage.countable && ` — ${formatNumber(stage.produced)}`}
              </span>
              {tab && <LinkButton onClick={() => onNavigate(tab)}>Open</LinkButton>}
              <span className="first-run__arrival-when">
                {stage.completedAt ? formatRelativeTime(stage.completedAt) : ""}
              </span>
            </li>
          );
        })}

        {pending.slice(0, 3).map((stage) => (
          <li className="first-run__arrival first-run__arrival--pending" key={stage.key}>
            <span className="first-run__arrival-dot first-run__arrival-dot--pending" aria-hidden="true" />
            <span className="first-run__arrival-label">
              <strong>{stage.label}</strong>
              {stage.state === "failed" && stage.error
                // A failed stage is reported here in the same list rather than hidden. The
                // pillar did not build, which is a fact the admin needs on the way past.
                ? ` — did not build: ${stage.error}`
                : stage.state === "running" ? " — running now" : " — not started"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FirstRunPanel({ onNavigate }) {
  const [state, setState] = React.useState({ loading: true });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setState({ loading: false, data: await invoke("getFirstRunState", {}) });
    } catch (err) {
      // A welcome panel that breaks the page it welcomes you to is worse than no panel.
      setState({ loading: false, data: null, error: err?.message || null });
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const mutate = async (payload) => {
    setBusy(true);
    try {
      await invoke("setFirstRunState", payload);
      await load();
    } catch {
      /* Leaving the panel as it was is the right failure: nothing was lost. */
    } finally {
      setBusy(false);
    }
  };

  if (state.loading || state.error || !state.data?.show) return null;

  const { steps = [], remaining, scanRunning, arrivals } = state.data;

  return (
    <Panel
      title="Getting started"
      icon="checkCircle"
      description={
        scanRunning
          ? "Your first scan is running. Sections become available as they land — you can start reading before it finishes."
          : `${formatNumber(remaining)} ${remaining === 1 ? "step" : "steps"} left to get the most out of Observatory.`
      }
      action={
        <button
          type="button"
          className="secondary-button secondary-button--small"
          onClick={() => mutate({ dismissed: true })}
          disabled={busy}
        >
          Dismiss
        </button>
      }
    >
      <ArrivalsList arrivals={arrivals} onNavigate={onNavigate} />

      <ul className="first-run__steps">
        {steps.map((step) => (
          <FirstRunStep
            key={step.key}
            step={step}
            busy={busy}
            onNavigate={onNavigate}
            onAcknowledge={(key) => mutate({ acknowledge: key })}
          />
        ))}
      </ul>
    </Panel>
  );
}
