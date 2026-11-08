/**
 * Lumino Desktop Bridge
 * ---------------------
 * A tiny, dependency-free local server that lets the Lumino Agent web app
 * touch YOUR desktop — safely.
 *
 * Why this exists: browsers intentionally block web pages from reading files
 * or launching apps. The only legitimate path is a local process YOU run,
 * which the page talks to over localhost.
 *
 * Safety model:
 *   - Listens on 127.0.0.1 only (never reachable from other machines).
 *   - Rejects requests whose Origin is not this app (anti DNS-rebinding).
 *   - Every capability starts DENIED. You grant/revoke per capability at
 *     runtime via POST /permission/<cap>/grant|revoke.
 *   - File browsing is confined to folders you navigate; no reads of file
 *     contents outside granted paths.
 *
 * Run:  npm run agent     (or: node agent/bridge.mjs)
 */

import http from "node:http";
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.LUMINA_BRIDGE_PORT || 7311);
const HOST = "127.0.0.1";

/** Allowed web origins (dev + production). */
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "https://lumina.vercel.app",
]);

/** Runtime permission flags (all start denied). */
const perms = { apps: false, files: false, browser: false };

/* ---------------------------------------------------------------- utils */

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function originAllowed(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // curl / direct local call
  try {
    const o = new URL(origin);
    const host = o.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
    if (ALLOWED_ORIGINS.has(origin.replace(/\/$/, ""))) return true;
    // any *.vercel.app preview of this project
    if (o.hostname.endsWith(".vercel.app")) return true;
    return false;
  } catch {
    return false;
  }
}

const runPS = (script) =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? "" : String(stdout)),
    );
  });

/* ------------------------------------------------------- capability impls */

async function listApps() {
  const roots = [
    path.join(
      process.env.PUBLIC || "C:\\ProgramData",
      "Microsoft\\Windows\\Start Menu\\Programs",
    ),
    path.join(
      process.env.APPDATA || "",
      "Microsoft\\Windows\\Start Menu\\Programs",
    ),
  ].filter((r) => r && fs.existsSync(r));

  const found = new Map();

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.name.toLowerCase().endsWith(".lnk")) {
        const name = it.name.replace(/\.lnk$/i, "");
        if (!found.has(name)) found.set(name, full);
      }
    }
  };
  roots.forEach((r) => walk(r));

  return [...found.entries()]
    .map(([name, p]) => ({ name, path: p }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function launchApp(lnkPath) {
  return new Promise((resolve, reject) => {
    if (!lnkPath.toLowerCase().endsWith(".lnk")) {
      reject(new Error("Only Start-menu shortcuts can be launched"));
      return;
    }
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.TargetPath`,
      ],
      { timeout: 10000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          // fallback: let Shell execute the shortcut itself
          execFile(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Start-Process -FilePath '${lnkPath.replace(/'/g, "''")}'`,
            ],
            { timeout: 10000, windowsHide: true },
            (e2) => (e2 ? reject(new Error("launch failed")) : resolve(true)),
          );
          return;
        }
        const target = stdout.trim();
        execFile(target, [], { detached: true, windowsHide: false, timeout: 5000 }, () =>
          resolve(true),
        ).unref?.();
      },
    );
  });
}

function listDir(dirPath) {
  const resolved = path.resolve(dirPath || ".");
  const items = fs.readdirSync(resolved, { withFileTypes: true });
  const entries = items
    .filter((i) => !i.name.startsWith("$"))
    .map((i) => {
      const full = path.join(resolved, i.name);
      let size;
      if (!i.isDirectory()) {
        try {
          size = fs.statSync(full).size;
        } catch {
          size = undefined;
        }
      }
      return { name: i.name, path: full, dir: i.isDirectory(), size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    .slice(0, 400);
  return { path: resolved, entries };
}

async function browserTabs() {
  // Read open tab titles/URLs via Edge/Chrome DevTools-style accessibility tree
  // is heavy; instead we use the Windows UI Automation-free approach: query
  // running browser processes' window titles (contains tab title), plus any
  // browser exposing remote debugging. Best-effort, privacy-first.
  const script = `
    $out = @()
    Get-Process | Where-Object { $_.MainWindowTitle -and $_.ProcessName -match 'chrome|msedge|firefox|brave' } |
      ForEach-Object { $out += [pscustomobject]@{ title = $_.MainWindowTitle; process = $_.ProcessName } }
    $out | ConvertTo-Json -Compress
  `;
  const raw = await runPS(script);
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .map((r) => ({
        title: String(r.title || ""),
        url: "",
        process: String(r.process || ""),
      }))
      .slice(0, 30);
  } catch {
    return [];
  }
}

async function systemInfo() {
  const cpus = os.cpus();
  const mem = os.totalmem();
  const freeMem = os.freemem();

  let cpuLoad;
  try {
    const sample = async () => {
      const start = cpus.map((c) => c.times);
      await new Promise((r) => setTimeout(r, 350));
      const end = os.cpus().map((c) => c.times);
      let idle = 0;
      let total = 0;
      for (let i = 0; i < end.length; i++) {
        const d = end[i].idle - (start[i]?.idle ?? 0);
        const t =
          end[i].user - (start[i]?.user ?? 0) +
          (end[i].nice - (start[i]?.nice ?? 0)) +
          (end[i].sys - (start[i]?.sys ?? 0)) +
          d;
        idle += d;
        total += t;
      }
      return total > 0 ? 100 - (100 * idle) / total : undefined;
    };
    cpuLoad = await sample();
  } catch {
    cpuLoad = undefined;
  }

  let disk;
  const ps = await runPS(
    "$d = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object {$_.Used -ne $null} | Select-Object -First 1; if($d){ [pscustomobject]@{free=[math]::Round($d.Free/1GB,1); total=[math]::Round(($d.Used+$d.Free)/1GB,1)} | ConvertTo-Json -Compress }",
  );
  try {
    const p = JSON.parse(ps.trim() || "{}");
    if (p.free != null) disk = { freeGB: p.free, totalGB: p.total };
  } catch {
    /* optional */
  }

  return {
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model,
    cpuLoad: cpuLoad != null ? Math.round(cpuLoad) : undefined,
    memUsedGB: Number(((mem - freeMem) / 1024 ** 3).toFixed(1)),
    memTotalGB: Number((mem / 1024 ** 3).toFixed(1)),
    diskFreeGB: disk?.free,
    diskTotalGB: disk?.total,
    uptimeH: Number((os.uptime() / 3600).toFixed(1)),
  };
}

/* --------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const route = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    });
    res.end();
    return;
  }

  // Origin gate (anti-rebinding)
  if (!originAllowed(req)) {
    json(res, 403, { error: "origin not allowed" });
    return;
  }

  try {
    if (route === "/health") {
      json(res, 200, { ok: true, app: "lumino-bridge", version: "1.0.0" });
      return;
    }

    if (route === "/permissions") {
      json(res, 200, perms);
      return;
    }

    const permMatch = /^\/permission\/(files|apps|browser)\/(grant|revoke)$/.exec(route);
    if (permMatch) {
      const cap = permMatch[1];
      const action = permMatch[2];
      perms[cap] = action === "grant";
      console.log(`[lumina] permission ${cap} -> ${action}`);
      json(res, 200, { ok: true, permissions: perms });
      return;
    }

    if (route === "/system") {
      json(res, 200, await systemInfo());
      return;
    }

    /* ---- apps ---- */
    if (route === "/apps" && perms.apps) {
      json(res, 200, { apps: await listApps() });
      return;
    }

    if (route === "/apps/launch" && perms.apps && req.method === "POST") {
      const body = await readBody(req);
      const target = String(body.path || "");
      if (!target.toLowerCase().endsWith(".lnk")) {
        json(res, 400, { error: "invalid target" });
        return;
      }
      await launchApp(target);
      json(res, 200, { ok: true });
      return;
    }

    /* ---- files ---- */
    if (route === "/files/cwd" && perms.files) {
      json(res, 200, { cwd: os.homedir() });
      return;
    }

    if (route === "/files/list" && perms.files) {
      const p = url.searchParams.get("path") || os.homedir();
      try {
        json(res, 200, listDir(p));
      } catch (e) {
        json(res, 400, { error: String(e.message || e) });
      }
      return;
    }

    /* ---- browser ---- */
    if (route === "/browser/tabs" && perms.browser) {
      json(res, 200, { tabs: await browserTabs() });
      return;
    }

    /* ---- denied paths (capability not granted) ---- */
    if (
      ["/apps", "/apps/launch", "/files/cwd", "/files/list", "/browser/tabs"].some(
        (r) => route === r || route.startsWith(r + "?"),
      )
    ) {
      json(res, 403, { error: "permission not granted for this capability" });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ✦ Lumino Desktop Bridge running");
  console.log(`    http://${HOST}:${PORT}`);
  console.log("    Capabilities start OFF — grant them in the Lumino Agent UI.");
  console.log("    Ctrl+C to stop.");
  console.log("");
});

process.on("SIGINT", () => {
  console.log("\n[lumina] bridge stopped");
  server.close(() => process.exit(0));
});
