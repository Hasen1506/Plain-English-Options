import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
  { test: { name: "diff", include: ["tests/diff/**/*.test.ts"], environment: "node" } },
  { test: { name: "live", include: ["tests/live/**/*.test.ts"], environment: "node", testTimeout: 240_000, hookTimeout: 60_000 } },
]);
