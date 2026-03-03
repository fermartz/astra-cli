/**
 * Desktop-specific tsup config: bundles ALL dependencies into a single
 * self-contained ESM file so the Electron app doesn't need node_modules.
 */
import { defineConfig } from "tsup";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

export default defineConfig({
  entry: ["src/bin/astra.ts"],
  format: "esm",
  target: "node18",
  outDir: "dist-desktop",
  clean: true,
  sourcemap: true,
  noSplitting: true,
  // Bundle ALL dependencies — no externals except Node.js built-ins
  noExternal: [/.*/],
  // Inject version so logo.ts doesn't need to read package.json at runtime
  define: {
    "process.env.__ASTRA_VERSION__": JSON.stringify(pkg.version),
  },
  banner: {
    // Provide require() in ESM context so bundled CJS deps (signal-exit etc.)
    // can require Node.js built-ins (assert, fs, path...)
    js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);',
  },
  esbuildOptions(options) {
    options.platform = "node";
    // Optional/dev-only imports that don't exist at runtime
    options.external = [...(options.external || []), "react-devtools-core"];
  },
  async onSuccess() {
    // Add package.json so Electron's Node.js recognises ESM format
    writeFileSync("dist-desktop/package.json", '{ "type": "module" }\n');
  },
  // No shebang needed — Electron runs this directly
});
