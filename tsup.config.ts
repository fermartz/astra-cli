import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin/astra.ts"],
  format: "esm",
  target: "node18",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
