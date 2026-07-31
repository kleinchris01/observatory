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
          include: ["src/**/*.test.js"],
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
      include: ["src/*.js", "src/lib/**/*.js", "static/src/**/*.{js,jsx}"],
      exclude: ["**/*.test.*", "static/src/test-setup.js"],
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
      thresholds: {
        lines: 65,
        functions: 44.5,
        branches: 54.5,
        "src/lib/jira-api.js": { lines: 97, functions: 95, branches: 79 },
        "src/index.js": { lines: 98, functions: 49, branches: 88 },
        "src/lib/report-engine.js": { lines: 100, functions: 100, branches: 95 },
        // Holds the authorization boundary -- withAdminGuard and the audit trail. A
        // regression here is a security regression, not a coverage statistic.
        "src/resolvers.js": { lines: 90, functions: 74, branches: 76 },
      },
    },
  },
});
