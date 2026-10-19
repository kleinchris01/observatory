import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateAudit, formatVerdict } from "./audit-gate.mjs";

const report = (vulns) => ({ vulnerabilities: vulns });
const accept = (pkg, reviewBy = "2027-01-19") => ({ package: pkg, severity: "high", reason: "x", reviewBy });
const TODAY = "2026-10-19";

describe("evaluateAudit", () => {
  test("passes when every high advisory has a current acceptance", () => {
    const v = evaluateAudit(report({ "linkify-it": { severity: "high" } }), [accept("linkify-it")], TODAY);
    expect(v).toEqual({ ok: true, unaccepted: [], expired: [], stale: [] });
  });

  test("fails on a new high or critical advisory nobody has accepted", () => {
    const v = evaluateAudit(report({ undici: { severity: "high" }, "evil-pkg": { severity: "critical" } }), [], TODAY);
    expect(v.ok).toBe(false);
    expect(v.unaccepted).toEqual([
      { package: "evil-pkg", severity: "critical" },
      { package: "undici", severity: "high" },
    ]);
  });

  test("ignores moderate and low advisories", () => {
    const v = evaluateAudit(report({ "markdown-it": { severity: "moderate" }, x: { severity: "low" } }), [], TODAY);
    expect(v.ok).toBe(true);
  });

  // An accepted risk is re-read, not kept forever by default.
  test("fails when an acceptance is past its review date, or has none", () => {
    const v = evaluateAudit(
      report({ a: { severity: "high" }, b: { severity: "high" } }),
      [accept("a", "2026-10-18"), { package: "b", severity: "high", reason: "x" }],
      TODAY,
    );
    expect(v.ok).toBe(false);
    expect(v.expired).toEqual([
      { package: "a", severity: "high", reviewBy: "2026-10-18" },
      { package: "b", severity: "high", reviewBy: null },
    ]);
  });

  test("a review date of today still passes", () => {
    expect(evaluateAudit(report({ a: { severity: "high" } }), [accept("a", TODAY)], TODAY).ok).toBe(true);
  });

  test("flags acceptances for packages that are no longer vulnerable, without failing", () => {
    const v = evaluateAudit(report({}), [accept("fixed-now")], TODAY);
    expect(v).toMatchObject({ ok: true, stale: ["fixed-now"] });
  });
});

describe("formatVerdict", () => {
  test("names each problem as a GitHub annotation", () => {
    const text = formatVerdict({
      ok: false,
      unaccepted: [{ package: "undici", severity: "high" }],
      expired: [{ package: "a", severity: "high", reviewBy: "2026-01-01" }],
      stale: ["old"],
    });
    expect(text).toContain("::error::undici (high) has no recorded acceptance");
    expect(text).toContain("::error::a (high): its acceptance was due for review on 2026-01-01.");
    expect(text).toContain("::warning::old is accepted but no longer reported vulnerable");
    expect(text).toContain("Dependency gate failed.");
  });
});

describe("audit-acceptances.json", () => {
  const { acceptances } = JSON.parse(readFileSync(new URL("./audit-acceptances.json", import.meta.url), "utf8"));

  test("every acceptance carries a reason and a dated review", () => {
    expect(acceptances.length).toBeGreaterThan(0);
    for (const a of acceptances) {
      expect(a.package, JSON.stringify(a)).toBeTruthy();
      expect(a.reason?.length, a.package).toBeGreaterThan(20);
      expect(a.reviewBy, a.package).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
