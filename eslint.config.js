import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/build/**",
      "**/dist/**",
      "**/dist-admin/**",
      "**/node_modules/**",
      "**/coverage/**",
      "src/lib/drift-engine.js",
    ],
  },
  js.configs.recommended,
  // Existing `eslint-disable no-await-in-loop` comments document deliberately sequential
  // Jira calls (rate limits, ordering). The rule itself is off -- it flags hundreds of
  // intentional loops -- so those comments are kept as documentation, not reported.
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  {
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": ["warn", { allow: ["warn", "error", "log", "info"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["static/**/*.{js,jsx}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
    // Pinned, not 'detect', so linting never depends on which package react resolves from.
    settings: { react: { version: "18.3" } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs["jsx-runtime"].rules,
      // The two classic hook rules only. The React Compiler rules in the plugin's recommended set
      // flag the deliberate latest-ref pattern (ref.current = fn during render).
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react/prop-types": "off",
      // Apostrophes in JSX copy render fine; escaping them would only make the copy harder to edit.
      "react/no-unescaped-entities": "off",
    },
  },
  {
    files: [
      "**/*.test.{js,jsx,mjs}",
      "**/__tests__/**/*.{js,jsx}",
      "**/__mocks__/**/*.{js,jsx}",
      "**/test-setup.js",
      "test/**/*.{js,jsx}",
    ],
    languageOptions: { globals: { ...globals.vitest } },
  },
  // Last, so formatting is Prettier's job alone.
  prettier,
];
