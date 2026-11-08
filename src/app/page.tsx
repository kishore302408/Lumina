"use client";

import { useCallback, useEffect, useState } from "react";
import Intro from "@/components/Intro";
import ChatPanel from "@/components/ChatPanel";
import VoicePanel from "@/components/VoicePanel";
import ImagePanel from "@/components/ImagePanel";
import VideoPanel from "@/components/VideoPanel";
import AgentPanel from "@/components/AgentPanel";
import SettingsPanel from "@/components/SettingsPanel";
import type { PanelId } from "@/lib/types";

const NAV: { id: PanelId; label: string; icon: React.ReactNode }[] = [
  {
    id: "chat",
    label: "Chat",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-3.8-.8L3 21l1.9-5.4A8.4 8.4 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z" />
      </svg>
    ),
  },
  {
    id: "voice",
    label: "Voice",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
      </svg>
    ),
  },
  {
    id: "image",
    label: "Image",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8.5" cy="8.5" r="1.7" />
        <path d="m21 15-4.6-4.6a2 2 0 0 0-2.8 0L4 20" />
      </svg>
    ),
  },
  {
    id: "video",
    label: "Video",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="14" height="14" rx="3" />
        <path d="m16 10 6-3.5v11L16 14" />
      </svg>
    ),
  },
  {
    id: "agent",
    label: "Agent",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="7" width="16" height="13" rx="3" />
        <path d="M12 3v4M9 13h.01M15 13h.01M9.5 17h5" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3.2" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

export default function Home() {
  const [introDone, setIntroDone] = useState(false);
  const [panel, setPanel] = useState<PanelId>("chat");
  const [dark, setDark] = useState(true);
  const [bridgeStatus, setBridgeStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");

  /* theme bootstraps from the inline script; sync state from DOM after
     hydration so server-rendered markup stays consistent (no flash). */
  useEffect(() => {
    const id = queueMicrotask(() => {
      const isDark = document.documentElement.classList.contains("dark");
      setDark(isDark);
      // skip intro for this session after first view
      if (sessionStorage.getItem("lumina.intro") === "seen") setIntroDone(true);
    });
    return () => {
      void id;
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem("lumina.theme", next ? "dark" : "light");
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);

  /* poll the local desktop bridge (agent column) */
  useEffect(() => {
    let stop = false;
    const ping = async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch("http://127.0.0.1:7311/health", {
          signal: ctl.signal,
          cache: "no-store",
        });
        clearTimeout(t);
        if (!stop) setBridgeStatus(r.ok ? "online" : "offline");
      } catch {
        if (!stop) setBridgeStatus("offline");
      }
    };
    ping();
    const iv = setInterval(ping, 8000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [introDone]);

  const onIntroDone = useCallback(() => {
    try {
      sessionStorage.setItem("lumina.intro", "seen");
    } catch {
      /* storage blocked */
    }
    setIntroDone(true);
  }, []);

  const statusLabel =
    bridgeStatus === "online"
      ? "Desktop linked"
      : bridgeStatus === "checking"
        ? "Checking bridge…"
        : "Desktop offline";

  return (
    <>
      {!introDone && <Intro onDone={onIntroDone} />}

      <div className="flex h-screen w-full overflow-hidden">
        {/* ---- rail ---- */}
        <aside className="glass flex w-[86px] shrink-0 flex-col items-center gap-1 border-r px-2 py-4">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl text-lg font-black text-white shadow-lg"
            style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}>
            L
          </div>

          <nav className="flex flex-1 flex-col gap-1.5">
            {NAV.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`nav-item w-[66px] ${panel === n.id ? "active" : ""}`}
                onClick={() => setPanel(n.id)}
                aria-current={panel === n.id}
              >
                {n.icon}
                {n.label}
              </button>
            ))}
          </nav>

          <button
            type="button"
            className="nav-item w-[66px]"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {dark ? (
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
              </svg>
            ) : (
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            )}
            {dark ? "Light" : "Dark"}
          </button>
        </aside>

        {/* ---- main ---- */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="glass flex h-[62px] shrink-0 items-center justify-between border-b px-6">
            <div className="flex items-baseline gap-3">
              <h1 className="brand-text text-lg font-extrabold tracking-tight">
                Lumino Agent
              </h1>
              <span className="pill hidden sm:inline-flex">
                <span
                  className={`dot ${
                    bridgeStatus === "online"
                      ? "ok"
                      : bridgeStatus === "checking"
                        ? "busy"
                        : "bad"
                  }`}
                />
                {statusLabel}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="pill hidden md:inline-flex">
                {NAV.find((n) => n.id === panel)?.label} column
              </span>
              <button type="button" className="btn" onClick={toggleTheme}>
                {dark ? "☀ Light" : "☾ Dark"}
              </button>
            </div>
          </header>

          <section className="min-h-0 flex-1 overflow-hidden">
            {panel === "chat" && <ChatPanel />}
            {panel === "voice" && <VoicePanel />}
            {panel === "image" && <ImagePanel />}
            {panel === "video" && <VideoPanel />}
            {panel === "agent" && <AgentPanel status={bridgeStatus} />}
            {panel === "settings" && <SettingsPanel />}
          </section>
        </main>
      </div>
    </>
  );
}
