"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteMemory,
  listConversations,
  listImages,
  listMemories,
  listVideos,
  messagesFor,
  putMemory,
  uid,
} from "@/lib/db";
import { PROVIDERS } from "@/lib/ai";
import { DEFAULT_PERSONAS } from "@/lib/types";

export default function SettingsPanel() {
  const [memories, setMemories] = useState<{ id: string; content: string; createdAt: number }[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [counts, setCounts] = useState({ conv: 0, msg: 0, img: 0, vid: 0 });
  const [note, setNote] = useState<string | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" && !document.documentElement.classList.contains("dark")
      ? "light"
      : "dark",
  );

  const refresh = useCallback(async () => {
    try {
      const [m, convs, imgs, vids] = await Promise.all([
        listMemories(),
        listConversations(),
        listImages(),
        listVideos(),
      ]);
      setMemories(m);
      const msgTotal = (
        await Promise.all(convs.map((c) => messagesFor(c.id)))
      ).reduce((n, arr) => n + arr.length, 0);
      setCounts({ conv: convs.length, msg: msgTotal, img: imgs.length, vid: vids.length });
    } catch {
      /* db unavailable */
    }
  }, []);

  useEffect(() => {
    const id = queueMicrotask(() => {
      void refresh();
    });
    return () => {
      void id;
    };
  }, [refresh]);

  const addMemory = async () => {
    const v = newMemory.trim();
    if (!v) return;
    try {
      await putMemory({ id: uid(), content: v, createdAt: Date.now() });
      setNewMemory("");
      setNote("Memory saved — Lumino will remember it in every chat.");
      await refresh();
    } catch {
      setNote("Could not save memory (storage unavailable).");
    }
  };

  const removeMemory = async (id: string) => {
    try {
      await deleteMemory(id);
    } catch {
      /* ignore */
    }
    await refresh();
  };

  const exportAll = async () => {
    try {
      const convs = await listConversations();
      const payload: Record<string, unknown> = { exportedAt: Date.now(), conversations: [] };
      const withMsgs = await Promise.all(
        convs.map(async (c) => ({ ...c, messages: await messagesFor(c.id) })),
      );
      payload.conversations = withMsgs;
      payload.memories = await listMemories();
      payload.images = await listImages();
      payload.videos = await listVideos();

      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lumina-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNote("Export downloaded.");
    } catch {
      setNote("Export failed.");
    }
  };

  const switchTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("lumina.theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };

  return (
    <div className="scroll-area h-full p-5 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h2 className="text-xl font-extrabold">
            Settings <span className="brand-text">& Memory</span>
          </h2>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Shape how Lumino behaves and control everything it stores.
          </p>
        </div>

        {/* appearance */}
        <div className="glass rounded-3xl p-5">
          <h3 className="mb-3 text-sm font-bold">Appearance</h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold">Theme</p>
              <p className="text-[0.7rem]" style={{ color: "var(--muted)" }}>
                Switch between dark and light. Saved for next visit.
              </p>
            </div>
            <button type="button" className="btn" onClick={switchTheme}>
              {theme === "dark" ? "☾ Dark (active)" : "☀ Light (active)"}
            </button>
          </div>
        </div>

        {/* memories */}
        <div className="glass rounded-3xl p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold">Long-term memory</h3>
            <span className="pill">{memories.length} saved</span>
          </div>
          <p className="mb-3 text-[0.7rem]" style={{ color: "var(--muted)" }}>
            Facts stored here are injected into every conversation — so Lumino
            remembers you across sessions. Stored only in your browser&apos;s
            database.
          </p>

          <div className="flex gap-2">
            <input
              className="input"
              placeholder="e.g. I prefer concise answers and I'm learning Rust"
              value={newMemory}
              onChange={(e) => setNewMemory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addMemory();
              }}
            />
            <button type="button" className="btn btn-primary shrink-0" onClick={() => void addMemory()}>
              Save
            </button>
          </div>

          <div className="mt-3 space-y-1.5">
            {memories.length === 0 && (
              <p className="py-2 text-center text-xs" style={{ color: "var(--muted)" }}>
                No memories yet.
              </p>
            )}
            {memories.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
                style={{ background: "var(--panel-2)" }}
              >
                <span className="min-w-0 flex-1">{m.content}</span>
                <button
                  type="button"
                  className="rounded-md px-1.5"
                  style={{ color: "var(--muted)" }}
                  onClick={() => void removeMemory(m.id)}
                  aria-label="Delete memory"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* personas */}
        <div className="glass rounded-3xl p-5">
          <h3 className="mb-3 text-sm font-bold">Personas</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            {DEFAULT_PERSONAS.map((p) => (
              <div key={p.id} className="glass-2 rounded-xl p-3">
                <p className="text-xs font-bold">{p.name}</p>
                <p className="mt-1 line-clamp-3 text-[0.66rem]" style={{ color: "var(--muted)" }}>
                  {p.system.slice(0, 110)}…
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[0.68rem]" style={{ color: "var(--muted)" }}>
            Pick a persona from the Chat column sidebar. Personas ship with the
            model layer and swap without touching the rest of the app.
          </p>
        </div>

        {/* data */}
        <div className="glass rounded-3xl p-5">
          <h3 className="mb-3 text-sm font-bold">Your data</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { l: "Chats", v: counts.conv },
              { l: "Messages", v: counts.msg },
              { l: "Images", v: counts.img },
              { l: "Videos", v: counts.vid },
            ].map((c) => (
              <div key={c.l} className="glass-2 rounded-xl px-3 py-2.5 text-center">
                <p className="text-lg font-extrabold">{c.v}</p>
                <p className="text-[0.6rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  {c.l}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={() => void exportAll()}>
              ⬇ Export everything
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (
                  window.confirm(
                    "Clear ALL Lumina data from this browser? This cannot be undone.",
                  )
                ) {
                  indexedDB.deleteDatabase("lumina-agent");
                  setNote("All local data cleared. Reload to start fresh.");
                  setCounts({ conv: 0, msg: 0, img: 0, vid: 0 });
                  setMemories([]);
                }
              }}
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              🗑 Clear all data
            </button>
          </div>
          {note && (
            <p className="mt-3 rounded-xl border px-3 py-2 text-xs"
              style={{ borderColor: "var(--border-strong)" }}>
              {note}
            </p>
          )}
        </div>

        {/* about */}
        <div className="glass rounded-3xl p-5">
          <h3 className="mb-2 text-sm font-bold">About</h3>
          <div className="space-y-1 text-[0.72rem]" style={{ color: "var(--muted)" }}>
            <p>
              <span className="brand-text font-bold">Lumino Agent</span> — chat,
              voice, image, video and optional desktop assistance in one place.
            </p>
            <p>
              Model layer:{" "}
              {PROVIDERS.map((p) => p.label).join(", ")} · swappable provider
              interface — drop in a custom-trained or paid model later without
              UI changes.
            </p>
            <p>
              Desktop access runs only through your local bridge process with
              per-capability permissions you grant and revoke.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
