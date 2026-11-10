/**
 * Next.js standalone output ships without the browser assets and public files.
 * This copies them in so the bundled server can serve the complete app.
 *
 * Run after `next build`:  node scripts/prepare-standalone.mjs
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error("[prepare] .next/standalone/server.js missing — run `next build` first.");
  process.exit(1);
}

const copies = [
  { from: join(root, ".next", "static"), to: join(standalone, ".next", "static") },
  { from: join(root, "public"), to: join(standalone, "public") },
  // The Electron app launches the bridge from inside the runtime bundle.
  { from: join(root, "agent", "bridge.mjs"), to: join(standalone, "agent", "bridge.mjs") },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) {
    console.error(`[prepare] source missing: ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[prepare] ${from} -> ${to}`);
}

console.log("[prepare] standalone bundle ready.");
