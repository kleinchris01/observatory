import react from "@vitejs/plugin-react";

export default [
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
        "@forge/bridge": new URL("./__mocks__/@forge/bridge.js", import.meta.url).pathname,
      },
    },
  },
];
