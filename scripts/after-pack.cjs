/**
 * electron-builder excludes the node_modules folder from extraResources by
 * default (a negated glob), but the bundled Next.js standalone server needs
 * its own node_modules next to server.js to resolve "next".
 *
 * This hook runs after all files are copied and restores that folder.
 */
const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const projectDir = (context.packager || context.app).projectDir || process.cwd();
  const from = join(projectDir, ".next", "standalone", "node_modules");
  const to = join(context.appOutDir, "resources", "runtime", "node_modules");

  if (!existsSync(from)) {
    throw new Error(`[afterPack] missing ${from} — run "npm run build:desktop" first.`);
  }
  if (!existsSync(join(context.appOutDir, "resources", "runtime", "server.js"))) {
    throw new Error(`[afterPack] runtime not found at ${to} — check extraResources config.`);
  }

  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[afterPack] restored runtime node_modules -> ${to}`);
};
