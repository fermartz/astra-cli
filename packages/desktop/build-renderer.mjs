import { build } from "esbuild";
import { cpSync, realpathSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bundle renderer.ts + xterm dependencies into a single JS file
await build({
  entryPoints: [resolve(__dirname, "src/renderer/renderer.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/renderer/renderer.js"),
  platform: "browser",
  target: "chrome120",
  format: "iife",
  sourcemap: true,
  minify: false,
});

// Copy static assets to dist
cpSync(
  resolve(__dirname, "src/renderer/index.html"),
  resolve(__dirname, "dist/renderer/index.html"),
);
cpSync(
  resolve(__dirname, "src/renderer/styles.css"),
  resolve(__dirname, "dist/renderer/styles.css"),
);

// Copy xterm.css — resolve through pnpm symlinks
const require = createRequire(import.meta.url);
const xtermPkg = dirname(require.resolve("@xterm/xterm/package.json"));
cpSync(
  resolve(xtermPkg, "css/xterm.css"),
  resolve(__dirname, "dist/renderer/xterm.css"),
);

console.log("Renderer built successfully.");
