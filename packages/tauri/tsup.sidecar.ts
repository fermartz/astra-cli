import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["sidecar/entry.ts"],
  format: "esm",
  target: "node20",
  outDir: "sidecar-dist",
  clean: true,
  noSplitting: true,
});
