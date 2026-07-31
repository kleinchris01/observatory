import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      reporter: ["text-summary", "lcov"],
      include: ["src/*.js", "src/lib/**/*.js", "static/src/**/*.{js,jsx}"],
      exclude: ["**/*.test.*", "static/src/test-setup.js"],
      // A ratchet, not a goal. These are set just below current actuals so coverage
      // can only go up: adding untested code fails CI, and raising the numbers is a
      // deliberate edit here. Per-file overrides pin the modules whose failure modes
      // are hardest to debug in production -- the Jira transport and the queue router.
      thresholds: {
        lines: 65.2,
        functions: 50,
        branches: 74,
        "src/lib/jira-api.js": { lines: 98, functions: 90, branches: 81 },
        "src/index.js": { lines: 98, functions: 85, branches: 83 },
        "src/lib/report-engine.js": { lines: 100, functions: 100, branches: 90 },
        // Holds the authorization boundary -- withAdminGuard and the audit trail. A
        // regression here is a security regression, not a coverage statistic.
        "src/resolvers.js": { lines: 93, functions: 100, branches: 73 },
      },
    },
  },
});
