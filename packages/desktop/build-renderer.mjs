import { build } from "esbuild";
import { cpSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

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

// Copy xterm.css
cpSync(
  resolve(__dirname, "node_modules/@xterm/xterm/css/xterm.css"),
  resolve(__dirname, "dist/renderer/xterm.css"),
);

console.log("Renderer built successfully.");
