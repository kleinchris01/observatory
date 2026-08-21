import React from "react";
import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { buildGovernanceLedger, useHealthHistory } from "./OverviewDashboard";
import { Sparkline, TrendDelta, bandFromScore } from "./ui";

// The ledger is the join between two panels that used to state the same facts separately:
// a scored bar in "Site health" and a counted, linked row in "What needs attention". These
// pin the properties that made merging them worth doing -- and the ones that would make it
// a regression if they broke.

vi.mock("@forge/bridge", () => ({
  invoke: vi.fn().mockResolvedValue({}),
  view: { getContext: vi.fn().mockResolvedValue({}) },
  router: { open: vi.fn() },
}));

const dim = (key, over = {}) => ({
  key, label: key, available: true, score: 50, detail: `${key} detail`, action: null, ...over,
});

const health = (over = {}) => ({
  score: 57, grade: "E",
  dimensions: [dim("automation-security", { score: 0 }), dim("automation-hygiene", { score: 19 })],
  pillars: [{
    key: "automation", label: "Automation", score: 31, grade: "E", available: true, scored: 2, total: 2,
    dimensions: [dim("automation-security", { score: 0 }), dim("automation-hygiene", { score: 19 })],
  }],
  ...over,
});

const finding = (over = {}) => ({
  key: "f1", dimension: "automation-security", pillar: "automation",
  tone: "critical", count: 86, title: "A finding", detail: "why it matters",
  onOpen: vi.fn(), openLabel: "Automation", ...over,
});

const rowFor = (ledger, key) => ledger.pillars.flatMap((p) => p.rows).find((r) => r.key === key);

describe("buildGovernanceLedger — joining scores to findings", () => {
  test("attaches a finding to the dimension it is evidence for", () => {
    const ledger = buildGovernanceLedger({ health: health(), findings: [finding()] });
    const row = rowFor(ledger, "automation-security");

    expect(row.score).toBe(0);
    expect(row.findings.map((f) => f.key)).toEqual(["f1"]);
  });

  test("a dimension can carry several findings", () => {
    // Automation hygiene covers both disabled rules and inert ones.
    const ledger = buildGovernanceLedger({
      health: health(),
      findings: [
        finding({ key: "disabled", dimension: "automation-hygiene", tone: "info" }),
        finding({ key: "inert", dimension: "automation-hygiene", tone: "info" }),
      ],
    });

    expect(rowFor(ledger, "automation-hygiene").findings).toHaveLength(2);
  });

  // The whole reason a finding's tone is authored by hand: it carries a consequence the
  // score cannot see. A credential rule is urgent at any count, and no score says so.
  test("a finding can escalate a row past what its score justifies", () => {
    const ledger = buildGovernanceLedger({
      health: health({
        pillars: [{ key: "automation", label: "Automation", available: true, score: 90, grade: "A", total: 1,
          dimensions: [dim("automation-security", { score: 95 })] }],
      }),
      findings: [finding({ dimension: "automation-security", tone: "critical" })],
    });

    // 95 bands as clear on its own. One rule in a thousand carrying a credential is still
    // a credential someone can read.
    expect(bandFromScore(95)).toBe("clear");
    expect(rowFor(ledger, "automation-security").band).toBe("critical");
  });

  // ...but it must not soften one. "Project consistency 0" under "cleanup when convenient"
  // is incoherent, and it happened: the over-configured finding is authored as low urgency
  // while the dimension it belongs to had bottomed out.
  test("a finding cannot soften a row below what its score implies", () => {
    const ledger = buildGovernanceLedger({
      health: health(),
      findings: [finding({ dimension: "automation-hygiene", tone: "info" })],
    });

    expect(bandFromScore(19)).toBe("warning");
    expect(rowFor(ledger, "automation-hygiene").band).toBe("warning");
  });

  test("the worst of several findings decides the row's band", () => {
    const ledger = buildGovernanceLedger({
      health: health({
        pillars: [{ key: "automation", label: "Automation", available: true, score: 90, grade: "A", total: 1,
          dimensions: [dim("automation-hygiene", { score: 95 })] }],
      }),
      findings: [
        finding({ key: "a", dimension: "automation-hygiene", tone: "info" }),
        finding({ key: "b", dimension: "automation-hygiene", tone: "critical" }),
      ],
    });

    expect(rowFor(ledger, "automation-hygiene").band).toBe("critical");
  });

  // A score alone can never claim "act now". Nobody has written down a consequence for it,
  // and without the cap a site would go red the moment a new dimension scored low.
  test("a bare score bands no worse than warning", () => {
    const ledger = buildGovernanceLedger({ health: health(), findings: [] });
    expect(rowFor(ledger, "automation-security").band).toBe("warning");
    expect(bandFromScore(0)).toBe("warning");
    expect(bandFromScore(95)).toBe("clear");
  });
});

describe("buildGovernanceLedger — nothing gets dropped", () => {
  // The risk in replacing the findings list with a table keyed on dimensions: a finding
  // that no dimension measures has nowhere to go and silently disappears.
  test("keeps a finding no dimension covers", () => {
    const ledger = buildGovernanceLedger({
      health: health(),
      findings: [finding({ key: "cleanup", dimension: null, pillar: "fields", tone: "info", title: "Fields suggested for cleanup" })],
    });

    const row = rowFor(ledger, "cleanup");
    expect(row).toBeTruthy();
    expect(row.score).toBeNull();
    expect(row.label).toBe("Fields suggested for cleanup");
    // Its count and its way in sit on the row rather than in a chip, so the title is not
    // rendered twice.
    expect(row.findings).toEqual([]);
    expect(row.count).toBe(86);
    expect(row.openLabel).toBe("Automation");
  });

  test("keeps a finding whose dimension is missing from this payload", () => {
    const ledger = buildGovernanceLedger({
      health: health(),
      findings: [finding({ key: "screen-dangling", dimension: "screen-integrity", pillar: "screens" })],
    });

    expect(rowFor(ledger, "screen-dangling")).toBeTruthy();
    expect(ledger.pillars.find((p) => p.key === "screens").label).toBe("Screens");
  });

  // The state a fresh install is in, and the one with the most to fix: findings exist and
  // nothing has been scored. The old findings panel did not depend on the score, and the
  // ledger must not either.
  test("renders findings with no health score at all", () => {
    const ledger = buildGovernanceLedger({ health: null, findings: [finding()] });

    expect(ledger.pillars).toHaveLength(1);
    expect(rowFor(ledger, "f1").band).toBe("critical");
  });

  test("a dimension that could not be scored still shows its finding", () => {
    const ledger = buildGovernanceLedger({
      health: health({
        pillars: [{
          key: "automation", label: "Automation", available: false, score: null, total: 1,
          reason: "No automation analysis yet.",
          dimensions: [dim("automation-security", { available: false, score: null, reason: "No automation analysis yet." })],
        }],
      }),
      findings: [finding()],
    });

    const row = rowFor(ledger, "automation-security");
    expect(row.available).toBe(true);
    expect(row.score).toBeNull();
    expect(row.band).toBe("critical");
  });

  test("returns null only when there is genuinely nothing to show", () => {
    expect(buildGovernanceLedger({ health: null, findings: [] })).toBeNull();
    expect(buildGovernanceLedger({ health: { score: null, dimensions: [], pillars: [] }, findings: [] })).toBeNull();
  });

  // A cached measurement from before pillars existed carries only a flat dimensions array.
  test("renders a payload built before pillars existed", () => {
    const ledger = buildGovernanceLedger({
      health: { score: 60, grade: "D", dimensions: [dim("field-naming", { score: 79 })] },
      findings: [],
    });

    expect(rowFor(ledger, "field-naming").score).toBe(79);
  });
});

describe("buildGovernanceLedger — ordering and tallies", () => {
  test("orders rows by urgency, then by worst score", () => {
    const ledger = buildGovernanceLedger({
      health: health({
        pillars: [{
          key: "automation", label: "Automation", available: true, score: 30, grade: "E", total: 3,
          dimensions: [dim("a", { score: 90 }), dim("b", { score: 20 }), dim("c", { score: 50 })],
        }],
      }),
      findings: [finding({ key: "urgent", dimension: "a", tone: "critical" })],
    });

    // "a" scores 90 but carries a critical finding, so it leads. Then the bare scores,
    // worst first.
    expect(ledger.pillars[0].rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  test("pillars follow the score's own order, not insertion order", () => {
    const ledger = buildGovernanceLedger({
      health: null,
      findings: [
        finding({ key: "p", pillar: "projects", dimension: null }),
        finding({ key: "f", pillar: "fields", dimension: null }),
        finding({ key: "w", pillar: "workflows", dimension: null }),
      ],
    });

    expect(ledger.pillars.map((p) => p.key)).toEqual(["fields", "workflows", "projects"]);
  });

  test("tallies each band for the summary beside the score", () => {
    const ledger = buildGovernanceLedger({
      health: health(),
      findings: [
        finding({ key: "a", dimension: "automation-security", tone: "critical" }),
        finding({ key: "b", dimension: "automation-hygiene", tone: "info" }),
      ],
    });

    // The info finding lands on a dimension scoring 19, which bands it up to warning --
    // the tally counts what each ROW ended up as, not what each finding was authored as.
    expect(ledger.counts).toEqual({ critical: 1, warning: 1, info: 0 });
  });
});

describe("buildGovernanceLedger — trends", () => {
  const history = (over = {}) => ({
    available: true, hasTrend: true, days: 90, delta: 4,
    dimensions: [{ key: "automation-security", score: 0, first: 12, delta: -12, points: [{ day: "d1", score: 12 }, { day: "d2", score: 0 }] }],
    ...over,
  });

  test("attaches a series to the dimension it belongs to", () => {
    const ledger = buildGovernanceLedger({ health: health(), findings: [], history: history() });

    expect(rowFor(ledger, "automation-security").trend).toMatchObject({ delta: -12 });
    // A dimension the window does not cover gets no trend rather than an empty one.
    expect(rowFor(ledger, "automation-hygiene").trend).toBeNull();
    expect(ledger.hasTrends).toBe(true);
  });

  // A single measurement is a point, not a trend. Drawing a line through one dot would
  // assert a stability nobody observed.
  test("offers no trends from a single measurement", () => {
    const ledger = buildGovernanceLedger({ health: health(), findings: [], history: history({ hasTrend: false }) });
    expect(ledger.hasTrends).toBe(false);
    expect(rowFor(ledger, "automation-security").trend).toBeNull();
  });

  test("offers no trends when no history has been recorded", () => {
    const ledger = buildGovernanceLedger({ health: health(), findings: [], history: { available: false } });
    expect(ledger.hasTrends).toBe(false);
  });
});

describe("Sparkline", () => {
  const points = (...scores) => scores.map((score, i) => ({ day: `d${i}`, score }));

  test("draws a line through the measured points", () => {
    const { container } = render(<Sparkline points={points(10, 40, 90)} />);
    const line = container.querySelector("polyline");

    expect(line).toBeTruthy();
    expect(line.getAttribute("points").split(" ")).toHaveLength(3);
  });

  test("marks direction so colour can carry it", () => {
    expect(render(<Sparkline points={points(10, 90)} />).container.querySelector("svg").className.baseVal).toMatch(/ui-spark--up/);
    expect(render(<Sparkline points={points(90, 10)} />).container.querySelector("svg").className.baseVal).toMatch(/ui-spark--down/);
    expect(render(<Sparkline points={points(50, 50)} />).container.querySelector("svg").className.baseVal).toMatch(/ui-spark--flat/);
  });

  test("renders a dash rather than a line when there is nothing to compare", () => {
    const { container } = render(<Sparkline points={points(50)} />);
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.textContent).toBe("—");
  });

  // A gap means the dimension was not measured that day. Plotting it as zero would draw a
  // collapse that never happened.
  test("skips unmeasured days rather than plotting them as zero", () => {
    const { container } = render(<Sparkline points={[{ score: 80 }, { score: null }, { score: 90 }]} />);
    expect(container.querySelector("polyline").getAttribute("points").split(" ")).toHaveLength(2);
  });

  test("scales against a fixed 0-100 axis, not a fitted one", () => {
    // Two nearly identical scores must not render as a dramatic slope.
    const { container } = render(<Sparkline points={points(50, 51)} height={16} />);
    const [a, b] = container.querySelector("polyline").getAttribute("points").split(" ").map((p) => Number(p.split(",")[1]));
    expect(Math.abs(a - b)).toBeLessThan(1);
  });
});

describe("TrendDelta", () => {
  test("signs the change so a rise always reads as good", () => {
    expect(render(<TrendDelta delta={12} />).container.textContent).toBe("+12");
    expect(render(<TrendDelta delta={-12} />).container.textContent).toBe("−12");
  });

  // "no comparison available" and "held steady" are different facts, and a dimension
  // nobody could compare has not held steady.
  test("renders nothing when there is no comparison", () => {
    expect(render(<TrendDelta delta={null} />).container.textContent).toBe("");
    expect(render(<TrendDelta delta={0} />).container.textContent).toBe("");
  });
});

describe("useHealthHistory", () => {
  function Probe({ load }) {
    const history = useHealthHistory({ load });
    return <span data-testid="out">{history ? String(history.score ?? "loaded") : "none"}</span>;
  }

  test("fetches the series for the default window", async () => {
    const load = vi.fn().mockResolvedValue({ available: true, score: 57 });
    render(<Probe load={load} />);

    await waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("57"));
    expect(load).toHaveBeenCalledWith("getHealthHistory", { days: 90 });
  });

  // The ledger renders completely without a trend column. A failed sparkline query is not
  // worth interrupting the page that says a rule is leaking a credential.
  test("a failure is silence, not an error", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("sql down"));
    render(<Probe load={load} />);

    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.getByTestId("out")).toHaveTextContent("none");
  });
});
