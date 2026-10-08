import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  // relative base: works at /Plain-English-Options/ on GitHub Pages whatever the case of the repo name
  base: mode === "e2e" ? "/" : "./",
  build: { outDir: mode === "e2e" ? "dist-e2e" : "dist", sourcemap: true, target: "es2022" },
  define: mode === "e2e" ? { "import.meta.env.VITE_E2E": JSON.stringify("1") } : {},
}));
