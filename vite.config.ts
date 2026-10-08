import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: mode === "e2e" ? "/" : "/plain-english-options/",
  build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", sourcemap: true, target: "es2022" },
  define: mode === "e2e" ? { "import.meta.env.VITE_E2E": JSON.stringify("1") } : {},
}));
