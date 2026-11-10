/**
 * Lumino Agent — Electron main process.
 *
 * Responsibilities:
 *   1. Start the bundled Next.js production server on a free localhost port.
 *   2. Start the local Desktop Bridge (unless one is already running).
 *   3. Open the app window once the server answers /health.
 *   4. Tear everything down cleanly on quit.
 *
 * The Next server and the bridge are spawned as Node processes using
 * ELECTRON_RUN_AS_NODE, so no separate Node installation is required.
 */
const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const WINDOW_ICON = path.join(__dirname, "icon.ico");
const BRIDGE_PORT = Number(process.env.LUMINA_BRIDGE_PORT || 7311);
const BRIDGE_HEALTH = `http://127.0.0.1:${BRIDGE_PORT}/health`;

let mainWindow = null;
let serverProc = null;
let bridgeProc = null;
let shuttingDown = false;

/* ------------------------------------------------------------------ utils */

const appRoot = () => app.getAppPath();

/**
 * Where the bundled Next server + bridge live.
 *  - packaged: <install>/resources/runtime   (copied there by electron-builder)
 *  - dev:      <project>/.next/standalone    (produced by `next build`)
 */
const runtimeDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "runtime")
    : path.join(appRoot(), ".next", "standalone");

const standaloneServerPath = () => path.join(runtimeDir(), "server.js");
const bridgePath = () => path.join(runtimeDir(), "agent", "bridge.mjs");

function log(...args) {
  console.log("[lumina]", ...args);
}

/** Find a free TCP port on the loopback interface. */
function findFreePort(start = 3211) {
  return new Promise((resolve) => {
    let port = start;
    const attempt = () => {
      if (port > start + 80) return resolve(0);
      const srv = net.createServer();
      srv.once("error", () => {
        port += 1;
        attempt();
      });
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    attempt();
  });
}

/** Poll a URL until it answers or the deadline passes. */
function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let settled = false;
      const retryOrFail = () => {
        if (settled) return;
        settled = true;
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(tick, 250);
      };
      const req = http.get(url, (res) => {
        if (settled) return;
        settled = true;
        res.resume();
        resolve(res.statusCode || 0);
      });
      req.on("error", retryOrFail);
      // A socket that closes without a response must also retry.
      req.on("close", retryOrFail);
      req.setTimeout(2000, () => req.destroy(new Error("request timeout")));
    };
    tick();
  });
}

function httpOk(url, timeoutMs = 1500) {
  return waitForHttp(url, timeoutMs).then(() => true, () => false);
}

/** Kill a child process and everything it spawned (Windows-safe). */
function killTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {});
    } else {
      proc.kill("SIGTERM");
    }
    log(`stopped ${label}`);
  } catch (err) {
    log(`could not stop ${label}:`, err.message);
  }
}

/* --------------------------------------------------------- child services */

function startNextServer() {
  const serverJs = standaloneServerPath();
  if (!fs.existsSync(serverJs)) {
    throw new Error(`Bundled server not found:\n${serverJs}`);
  }

  let resolveExit;
  serverExited = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const proc = spawn(process.execPath, [serverJs], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(serverPort),
      HOSTNAME: "127.0.0.1",
      NEXT_TELEMETRY_DISABLED: "1",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  proc.stdout.on("data", (d) => log("server:", String(d).trim()));
  proc.stderr.on("data", (d) => log("server:", String(d).trim()));
  proc.on("exit", (code, signal) => {
    log(`server exited (code=${code} signal=${signal})`);
    if (resolveExit) resolveExit({ code, signal });
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Lumino Agent",
        message: "The local server stopped unexpectedly.",
        detail: `Exit code: ${code ?? "unknown"}\n\nThe window will close. Reopen Lumino Agent to try again.`,
        buttons: ["OK"],
      }).finally(() => app.quit());
    }
  });
  proc.on("error", (err) => log("server spawn error:", err.message));

  return proc;
}

async function startBridge() {
  // Reuse a bridge the user already started with `npm run agent`.
  if (await httpOk(BRIDGE_HEALTH, 1200)) {
    log("bridge already running — reusing it");
    return null;
  }

  const script = bridgePath();
  if (!fs.existsSync(script)) {
    log("bridge script missing — desktop access unavailable");
    return null;
  }

  const proc = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      LUMINA_BRIDGE_PORT: String(BRIDGE_PORT),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  proc.stderr.on("data", (d) => log("bridge:", String(d).trim()));
  proc.on("exit", (code) => {
    log(`bridge exited (code=${code})`);
    if (!shuttingDown && bridgeProc === proc) bridgeProc = null;
  });
  proc.on("error", (err) => log("bridge spawn error:", err.message));

  const ready = await httpOk(BRIDGE_HEALTH, 6000);
  log(ready ? "bridge ready" : "bridge did not answer in time");
  return proc;
}

/* ---------------------------------------------------------------- window */

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: true,
    backgroundColor: "#07080f",
    title: "Lumino Agent",
    icon: fs.existsSync(WINDOW_ICON) ? WINDOW_ICON : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.setMenuBarVisibility(true);

  // External links open in the user's default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc) => {
    log("page failed to load:", code, desc);
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  void win.loadURL(url);
  return win;
}

/* ----------------------------------------------------------------- boot */

let serverPort = 0;
let serverExited = null;

async function boot() {
  serverPort = await findFreePort();
  if (!serverPort) throw new Error("No free local port available.");

  log(`starting server on 127.0.0.1:${serverPort}`);
  serverProc = startNextServer();

  const url = `http://127.0.0.1:${serverPort}`;
  await Promise.race([
    waitForHttp(`${url}/`, 45000),
    serverExited.then(({ code, signal }) => {
      throw new Error(`The local server exited during startup (code ${code ?? signal ?? "unknown"}).`);
    }),
  ]);
  log("server ready");

  mainWindow = createWindow(url);

  // Desktop bridge is optional — the app works without it.
  startBridge()
    .then((proc) => {
      if (proc) bridgeProc = proc;
    })
    .catch((err) => log("bridge error:", err.message));
}

/* -------------------------------------------------------------- app wiring */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Keep the standard Edit/View menus so copy/paste shortcuts work.
    Menu.setApplicationMenu(Menu.getApplicationMenu());

    try {
      await boot();
    } catch (err) {
      log("boot failed:", err.message);
      dialog.showErrorBox(
        "Lumino Agent could not start",
        `${err.message}\n\nTry reopening the app. If it keeps failing, reinstall Lumino Agent.`,
      );
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    // Windows/Linux: closing the last window quits the app.
    app.quit();
  });

  app.on("before-quit", () => {
    shuttingDown = true;
    killTree(serverProc, "server");
    killTree(bridgeProc, "bridge");
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null && serverPort) {
      mainWindow = createWindow(`http://127.0.0.1:${serverPort}`);
    }
  });
}
