import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    globals: true,
    // Inlined from vitest.workspace.js, which Vitest 4 removed. The split is by RUNTIME,
    // not by test tier: backend code runs on Node under Forge, frontend runs in a browser
    // iframe, and running either in the wrong environment produces failures that look like
    // product bugs. When this config was still a workspace file under Vitest 4 it was
    // silently ignored -- every frontend test ran in Node and failed on `document`.
    projects: [
      {
        test: {
          name: "backend",
          include: ["src/**/*.test.js", "scripts/**/*.test.js"],
          environment: "node",
          globals: true,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "frontend",
          include: ["static/src/**/*.test.{js,jsx}"],
          environment: "jsdom",
          globals: true,
          setupFiles: ["static/src/test-setup.js"],
          alias: {
            // @forge/bridge only exists inside a Forge iframe, so it is replaced wholesale
            // with a mock exposing invoke/view/router/rovo.
            "@forge/bridge": new URL("./__mocks__/@forge/bridge.js", import.meta.url).pathname,
          },
        },
      },
    ],
    coverage: {
      reporter: ["text-summary", "lcov"],
      include: ["src/*.js", "src/lib/**/*.js", "src/resolvers/**/*.js", "static/src/**/*.{js,jsx}"],
      exclude: ["**/*.test.*", "static/src/test-setup.js", "src/resolvers/test-harness.js"],
      // A ratchet, not a goal. These are set just below current actuals so coverage
      // can only go up: adding untested code fails CI, and raising the numbers is a
      // deliberate edit here. Per-file overrides pin the modules whose failure modes
      // are hardest to debug in production -- the Jira transport and the queue router.
      //
      // REBASED for Vitest 4 (31 Jul 2026). Its v8-to-istanbul conversion counts
      // functions and branches differently: arrow functions and callbacks that used to
      // be merged into their enclosing function are now counted individually, roughly
      // 2.5x-ing the function denominator. Nothing about the tests changed -- per-file
      // LINE coverage is near-identical across the upgrade (index.js 98.7 -> 98.45,
      // report-engine 100 -> 100, jira-api 98.7 -> 97.6). Do not read the lower
      // function/branch numbers below as a regression, and do not compare them to
      // anything recorded before this date.
      // RATCHETED UP 3 Aug 2026 alongside the storage-layer and RQT test suites.
      // Global function coverage went 44.5 -> 64.2 by testing project-store.js directly
      // (it was 16 of 295 functions, because every other suite mocks it wholesale) and by
      // giving RqtTab.jsx its first tests. Globals below are re-pinned just under the new
      // actuals, which is a ~20 point ratchet.
      //
      // Three per-file BRANCH pins moved DOWN by under half a point. That is not a
      // regression in tested behaviour: the workflow insights, per-status counts and
      // queued workflow build added new branches to these files faster than the new tests
      // covered them, and each remaining gap is an error path with no distinct
      // observable. Pinned to actuals so they cannot slip further.
      // RATCHETED 19 Oct 2026 (docs/resolvers-refactor.md, follow-up 4), from 78 / 67 / 64.5 --
      // eight to thirteen points of regression the old floors would have let through. Globals sit
      // half a point under actuals (87.0 / 80.1 / 74.2) so platform noise between Windows and CI
      // cannot fail a build; per-module pins sit at actuals rounded down to the half point.
      thresholds: {
        lines: 86.5,
        functions: 79.5,
        branches: 73.5,
        "src/lib/jira-api.js": { lines: 96, functions: 95, branches: 78.5 },
        "src/index.js": { lines: 96, functions: 49, branches: 86.5 },
        "src/lib/report-engine.js": { lines: 100, functions: 100, branches: 94.5 },
        // The authorization boundary -- withAdminGuard and the audit trail, and the macro's
        // reader-group guard. A regression here is a security regression, not a coverage
        // statistic. Split out of resolvers.js (docs/resolvers-refactor.md); pinned at actuals.
        "src/resolvers/admin-guard.js": { lines: 100, functions: 100, branches: 88.5 },
        "src/resolvers/macro-access.js": { lines: 95, functions: 100, branches: 87.5 },
        // Rewrites thresholds and the macro access group list; decides which projects a
        // viewer is scoped to.
        "src/resolvers/admin-config.js": { lines: 84.5, functions: 100, branches: 73 },
        "src/resolvers/viewer.js": { lines: 96, functions: 83, branches: 77.5 },
        // Re-pinned 14 Oct 2026 by split PR 3, from 90 / 74 / 75.5. No code lost its tests:
        // statement totals are identical to master. The best-covered domains moved into the
        // modules pinned below, so what remains here averages lower. Per-module floors replace
        // this one as the split finishes (docs/resolvers-refactor.md).
        // After the split (PR 6) this file is only the registry: which resolver is reachable
        // from the macro and which only behind the admin guard. Fully covered, and kept there.
        "src/resolvers.js": { lines: 100, functions: 100, branches: 100 },
        // The Rovo actions, one module per agent, pinned together at their weakest member.
        "src/resolvers/rovo/**": { lines: 75, functions: 64, branches: 56 },
        // Functions re-pinned 80.5 -> 71.5 on 19 Oct 2026 by follow-up 2: ~50 covered selector
        // functions moved to src/lib/remediation-candidates.js (pinned below). What remains
        // uncovered here is the same .catch fallbacks as before; lines and branches went up.
        "src/resolvers/remediation.js": { lines: 94.5, functions: 71.5, branches: 76 },
        "src/lib/remediation-candidates.js": { lines: 96.5, functions: 95, branches: 73.5 },
        "src/lib/admin-overview.js": { lines: 100, functions: 100, branches: 94 },
        "src/resolvers/overview.js": { lines: 95, functions: 77.5, branches: 90 },
        "src/resolvers/reports.js": { lines: 92, functions: 65.5, branches: 84 },
        "src/resolvers/project-overview.js": { lines: 78.5, functions: 52.5, branches: 75 },
        "src/resolvers/workflows.js": { lines: 91, functions: 68.5, branches: 80 },
        "src/resolvers/deletion-safety.js": { lines: 87, functions: 70, branches: 88 },
        "src/resolvers/project-usage.js": { lines: 92, functions: 82.5, branches: 71.5 },
        "src/resolvers/scans.js": { lines: 82.5, functions: 72.5, branches: 77.5 },
        "src/resolvers/fields.js": { lines: 92.5, functions: 60.5, branches: 80 },
        "src/resolvers/automation.js": { lines: 95.5, functions: 89, branches: 82.5 },
        "src/resolvers/filters-dashboards.js": { lines: 94.5, functions: 77, branches: 82.5 },
        "src/resolvers/screens.js": { lines: 86, functions: 78, branches: 80 },
        // Pinned 19 Oct 2026 (docs/resolvers-refactor.md, follow-up 4): every resolver module now has
        // its own floor, so a module losing tests fails CI even while the global average holds.
        "src/resolvers/access.js": { lines: 96, functions: 85.5, branches: 84.5 },
        "src/resolvers/admin-tools.js": { lines: 100, functions: 100, branches: 50 },
        "src/resolvers/assets.js": { lines: 94.5, functions: 100, branches: 94 },
        "src/resolvers/boards.js": { lines: 88, functions: 63.5, branches: 87.5 },
        "src/resolvers/changes.js": { lines: 96.5, functions: 100, branches: 85.5 },
        "src/resolvers/estate.js": { lines: 95, functions: 100, branches: 90 },
        "src/resolvers/issue-types.js": { lines: 95.5, functions: 91.5, branches: 88 },
        "src/resolvers/jsm.js": { lines: 100, functions: 100, branches: 100 },
        "src/resolvers/apps.js": { lines: 100, functions: 100, branches: 100 },
        "src/lib/apps-probe.js": { lines: 99, functions: 91.5, branches: 85 },
        "src/resolvers/people.js": { lines: 83.5, functions: 57.5, branches: 81 },
        "src/resolvers/rqt.js": { lines: 95.5, functions: 100, branches: 78.5 },
        // The macro's pillar reads: the one surface non-admins reach, scoped per viewer.
        "src/resolvers/macro.js": { lines: 88.5, functions: 72, branches: 70.5 },
      },
    },
  },
});
