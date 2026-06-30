import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      reporter: ["text-summary", "lcov"],
      include: ["src/lib/**/*.js", "static/src/**/*.{js,jsx}"],
      exclude: ["**/*.test.*", "static/src/test-setup.js"],
    },
  },
});
