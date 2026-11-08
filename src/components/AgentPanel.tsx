"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Agent column — talks to the Lumino Desktop Bridge (a tiny local server).
 *
 * The bridge runs on YOUR machine (npm run agent), which is the only way a
 * web page can ever touch desktop apps/files: the browser sandbox forbids it
 * otherwise. Nothing runs without your explicit approval — the bridge only
 * exposes operations you grant permission for, and the UI shows that clearly.
 */

const BRIDGE = "http://127.0.0.1:7311";

type Status = "checking" | "online" | "offline";

interface PermissionState {
  files: boolean;
  apps: boolean;
  browser: boolean;
}

interface SystemInfo {
  platform: string;
  hostname: string;
  cpuModel?: string;
  cpuLoad?: number;
  memUsedGB?: number;
  memTotalGB?: number;
  diskFreeGB?: number;
  diskTotalGB?: number;
  uptimeH?: number;
}

interface AppEntry {
  name: string;
  path: string;
}

interface FileEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

interface TabEntry {
  title: string;
  url: string;
}

async function bridgeFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE}${path}`, {
      ...init,
      signal: ctl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `bridge error ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export default function AgentPanel({ status }: { status: Status }) {
  const [perms, setPerms] = useState<PermissionState>({
    files: false,
    apps: false,
    browser: false,
  });
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [appQuery, setAppQuery] = useState("");
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const online = status === "online";

  const grant = useCallback(
    async (key: keyof PermissionState) => {
      if (!online) return;
      setBusy(true);
      setNote(null);
      try {
        const res = await bridgeFetch<{ ok: boolean; message?: string }>(
          `/permission/${key}/grant`,
          { method: "POST" },
        );
        if (res.ok) {
          setPerms((p) => ({ ...p, [key]: true }));
          setNote(`Permission granted: ${key}. You can revoke it any time.`);
          if (key === "apps") {
            const list = await bridgeFetch<{ apps: AppEntry[] }>("/apps");
            setApps(list.apps);
          }
          if (key === "files") {
            const info = await bridgeFetch<{ cwd: string }>("/files/cwd");
            setCwd(info.cwd);
            const list = await bridgeFetch<{ entries: FileEntry[] }>(
              `/files/list?path=${encodeURIComponent(info.cwd)}`,
            );
            setEntries(list.entries);
          }
          if (key === "browser") {
            const list = await bridgeFetch<{ tabs: TabEntry[] }>("/browser/tabs");
            setTabs(list.tabs);
          }
        } else {
          setNote(res.message ?? "Permission was not granted.");
        }
      } catch (e) {
        setNote(e instanceof Error ? e.message : "Grant failed.");
      } finally {
        setBusy(false);
      }
    },
    [online],
  );

  const revoke = useCallback(async (key: keyof PermissionState) => {
    try {
      await bridgeFetch(`/permission/${key}/revoke`, { method: "POST" });
    } catch {
      /* bridge may be down */
    }
    setPerms((p) => ({ ...p, [key]: false }));
    if (key === "apps") setApps([]);
    if (key === "files") setEntries([]);
    if (key === "browser") setTabs([]);
    setNote(`Permission revoked: ${key}.`);
  }, []);

  useEffect(() => {
    if (!online) return;
    let stop = false;
    (async () => {
      try {
        const [sys, p] = await Promise.all([
          bridgeFetch<SystemInfo>("/system"),
          bridgeFetch<Record<string, boolean>>("/permissions"),
        ]);
        if (stop) return;
        setSystem(sys);
        setPerms({
          files: Boolean(p.files),
          apps: Boolean(p.apps),
          browser: Boolean(p.browser),
        });
        if (p.files) {
          const info = await bridgeFetch<{ cwd: string }>("/files/cwd");
          setCwd(info.cwd);
          const list = await bridgeFetch<{ entries: FileEntry[] }>(
            `/files/list?path=${encodeURIComponent(info.cwd)}`,
          );
          if (!stop) setEntries(list.entries);
        }
        if (p.apps) {
          const list = await bridgeFetch<{ apps: AppEntry[] }>("/apps");
          if (!stop) setApps(list.apps);
        }
        if (p.browser) {
          const list = await bridgeFetch<{ tabs: TabEntry[] }>("/browser/tabs");
          if (!stop) setTabs(list.tabs);
        }
      } catch {
        /* status pill already reports offline */
      }
    })();
    return () => {
      stop = true;
    };
  }, [online]);

  const browse = useCallback(async (path: string) => {
    setFileError(null);
    try {
      const list = await bridgeFetch<{ entries: FileEntry[]; path: string }>(
        `/files/list?path=${encodeURIComponent(path)}`,
      );
      setEntries(list.entries);
      setCwd(list.path);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : "Cannot open that folder.");
    }
  }, []);

  const launch = useCallback(
    async (app: AppEntry) => {
      setBusy(true);
      setNote(null);
      try {
        await bridgeFetch("/apps/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: app.path }),
        });
        setNote(`Launched ${app.name}`);
      } catch (e) {
        setNote(e instanceof Error ? e.message : "Launch failed.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const refreshTabs = useCallback(async () => {
    try {
      const list = await bridgeFetch<{ tabs: TabEntry[] }>("/browser/tabs");
      setTabs(list.tabs);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not read browser tabs.");
    }
  }, []);

  const filteredApps = apps.filter((a) =>
    a.name.toLowerCase().includes(appQuery.toLowerCase()),
  );

  const upPath = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).join("/");

  return (
    <div className="scroll-area h-full p-5 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        {/* header */}
        <div className="glass rounded-3xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-extrabold">
                Desktop <span className="brand-text">Bridge</span>
              </h2>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Local companion process — the only safe way a web app can touch
                your desktop. Every capability is off until you grant it.
              </p>
            </div>
            <span className="pill">
              <span
                className={`dot ${online ? "ok" : status === "checking" ? "busy" : "bad"}`}
              />
              {online ? "Connected" : status === "checking" ? "Checking…" : "Not connected"}
            </span>
          </div>

          {!online && (
            <div className="glass-2 mt-4 rounded-2xl p-4">
              <p className="text-xs font-semibold">Connect your desktop:</p>
              <ol className="mt-2 space-y-1.5 text-xs" style={{ color: "var(--muted)" }}>
                <li>
                  1. Open a terminal in the Lumina folder and run{" "}
                  <code className="rounded bg-[rgba(127,127,127,.18)] px-1.5 py-0.5 font-mono">
                    npm run agent
                  </code>
                </li>
                <li>2. Leave that window open — it starts on port 7311.</li>
                <li>3. This panel connects automatically within 8 seconds.</li>
              </ol>
              <p className="mt-2 text-[0.68rem]" style={{ color: "var(--muted)" }}>
                Why: browsers block page→desktop access by design. The bridge is a
                local process you control, and it only answers requests from this
                app while it runs.
              </p>
            </div>
          )}

          {system && (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { l: "Machine", v: system.hostname },
                { l: "OS", v: system.platform },
                {
                  l: "CPU",
                  v: system.cpuLoad != null ? `${Math.round(system.cpuLoad)}% load` : "—",
                },
                {
                  l: "Memory",
                  v:
                    system.memUsedGB != null && system.memTotalGB != null
                      ? `${system.memUsedGB.toFixed(1)} / ${system.memTotalGB.toFixed(1)} GB`
                      : "—",
                },
              ].map((c) => (
                <div key={c.l} className="glass-2 rounded-xl px-3 py-2">
                  <p className="text-[0.6rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                    {c.l}
                  </p>
                  <p className="truncate text-xs font-semibold">{c.v ?? "—"}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {note && (
          <div
            className="rounded-xl border px-3 py-2 text-xs"
            style={{ borderColor: "var(--border-strong)", color: "var(--text)" }}
          >
            {note}
          </div>
        )}

        {/* permission cards */}
        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              {
                key: "apps" as const,
                title: "Desktop apps",
                desc: "List and launch installed applications.",
              },
              {
                key: "files" as const,
                title: "Files & folders",
                desc: "Browse the folder you choose. Nothing else.",
              },
              {
                key: "browser" as const,
                title: "Browser tabs",
                desc: "Read your open tabs for live web context.",
              },
            ]
          ).map((c) => (
            <div key={c.key} className="glass card-hover rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">{c.title}</p>
                <span className="pill">
                  <span className={`dot ${perms[c.key] ? "ok" : "bad"}`} />
                  {perms[c.key] ? "Granted" : "Off"}
                </span>
              </div>
              <p className="mt-1.5 text-[0.7rem]" style={{ color: "var(--muted)" }}>
                {c.desc}
              </p>
              <button
                type="button"
                className={`btn mt-3 w-full ${perms[c.key] ? "" : "btn-primary"}`}
                disabled={!online || busy}
                onClick={() => (perms[c.key] ? void revoke(c.key) : void grant(c.key))}
              >
                {perms[c.key] ? "Revoke access" : "Grant access"}
              </button>
            </div>
          ))}
        </div>

        {/* apps */}
        {perms.apps && online && (
          <div className="glass rounded-3xl p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold">Installed apps</h3>
              <input
                className="input max-w-[220px]"
                placeholder="Search apps…"
                value={appQuery}
                onChange={(e) => setAppQuery(e.target.value)}
              />
            </div>
            <div className="scroll-area max-h-[260px] space-y-1.5 pr-1">
              {filteredApps.length === 0 && (
                <p className="py-4 text-center text-xs" style={{ color: "var(--muted)" }}>
                  {apps.length === 0 ? "Loading app list…" : "No matches."}
                </p>
              )}
              {filteredApps.map((a) => (
                <div
                  key={a.path}
                  className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs"
                  style={{ background: "var(--panel-2)" }}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                  <button
                    type="button"
                    className="btn !py-1 !text-[0.7rem]"
                    onClick={() => void launch(a)}
                    disabled={busy}
                  >
                    Launch
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* files */}
        {perms.files && online && (
          <div className="glass rounded-3xl p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold">File explorer</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn !py-1 !text-[0.7rem]"
                  onClick={() => void browse(upPath)}
                  disabled={!upPath}
                >
                  ↑ Up
                </button>
                <button
                  type="button"
                  className="btn !py-1 !text-[0.7rem]"
                  onClick={() => void browse(cwd)}
                >
                  ↻ Refresh
                </button>
              </div>
            </div>
            <p className="mb-2 truncate font-mono text-[0.68rem]" style={{ color: "var(--muted)" }}>
              {cwd}
            </p>
            {fileError && (
              <p className="mb-2 text-xs" style={{ color: "var(--danger)" }}>
                {fileError}
              </p>
            )}
            <div className="scroll-area max-h-[300px] space-y-1 pr-1">
              {entries.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition hover:bg-[var(--accent-soft)]"
                  onClick={() => {
                    if (e.dir) void browse(e.path);
                    else setNote(`Selected file: ${e.name}`);
                  }}
                >
                  <span>{e.dir ? "📁" : "📄"}</span>
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {!e.dir && (
                    <span className="shrink-0 text-[0.62rem]" style={{ color: "var(--muted)" }}>
                      {e.size != null ? `${(e.size / 1024).toFixed(1)} KB` : ""}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* browser */}
        {perms.browser && online && (
          <div className="glass rounded-3xl p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-bold">Live browser context</h3>
              <button type="button" className="btn !py-1 !text-[0.7rem]" onClick={() => void refreshTabs()}>
                ↻ Refresh
              </button>
            </div>
            {tabs.length === 0 ? (
              <p className="py-3 text-center text-xs" style={{ color: "var(--muted)" }}>
                No open tabs found — open Chrome or Edge and refresh.
              </p>
            ) : (
              <div className="scroll-area max-h-[300px] space-y-1.5 pr-1">
                {tabs.map((t, i) => (
                  <a
                    key={`${t.url}-${i}`}
                    href={t.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block rounded-xl border px-3 py-2 transition hover:border-[var(--accent)]"
                    style={{ background: "var(--panel-2)" }}
                  >
                    <p className="truncate text-xs font-semibold">{t.title}</p>
                    <p className="truncate text-[0.65rem]" style={{ color: "var(--muted)" }}>
                      {t.url}
                    </p>
                  </a>
                ))}
              </div>
            )}
            <p className="mt-2 text-[0.65rem]" style={{ color: "var(--muted)" }}>
              Tab titles/URLs can be injected into chat as live context when you ask.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
