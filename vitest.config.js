import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.js"],
    coverage: {
      reporter: ["text-summary", "lcov"],
      include: ["src/lib/**/*.js"],
      exclude: ["src/lib/**/*.test.js"],
    },
  },
});
