import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["packages/tauri/sidecar/entry.ts"],
  format: "esm",
  target: "node20",
  outDir: "packages/tauri/sidecar-dist",
  clean: true,
  noSplitting: true,
  noExternal: [/.*/],
  platform: "node",
  banner: {
    // Provide require() in ESM context so bundled CJS deps (safe-buffer, bs58, etc.)
    // can require Node.js built-ins (buffer, fs, path...)
    js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);',
  },
});
