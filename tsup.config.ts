import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin/astra.ts"],
  format: "esm",
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Keep the single-file bundle (dist/astra.js) — dynamic imports would create extra chunks
  // that aren't included in the npm package files list.
  noSplitting: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
