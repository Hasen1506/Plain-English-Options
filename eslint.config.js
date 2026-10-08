import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-e2e/", "node_modules/", "test-results/", "playwright-report/", "tests/fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { window: "readonly", document: "readonly", console: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", queueMicrotask: "readonly", Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly", location: "readonly", HTMLElement: "readonly", HTMLInputElement: "readonly", HTMLButtonElement: "readonly", HTMLSelectElement: "readonly", SVGRectElement: "readonly", WebSocket: "readonly" } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
);
