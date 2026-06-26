import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

function renameAdminHtml() {
  return {
    name: "rename-admin-html",
    enforce: "post",
    generateBundle(_options, bundle) {
      if (bundle["admin.html"]) {
        const entry = bundle["admin.html"];
        entry.fileName = "index.html";
        bundle["index.html"] = entry;
        delete bundle["admin.html"];
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isAdmin = mode === "admin";
  return {
    root: "static",
    base: "./",
    plugins: [react(), ...(isAdmin ? [renameAdminHtml()] : [])],
    build: {
      outDir: isAdmin ? "dist-admin" : "dist",
      emptyOutDir: true,
      rollupOptions: isAdmin ? {
        input: { admin: resolve(__dirname, "static/admin.html") },
      } : undefined,
    },
  };
});
