"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteVideo, listVideos, putVideo, uid } from "@/lib/db";
import { fetchImageBlob, imageUrl, ImageBusyError } from "@/lib/ai";
import type { GeneratedVideo } from "@/lib/types";

/**
 * Video column — Lumino renders a real motion clip:
 *   1. generates keyframe images from your prompt (via the image engine)
 *   2. animates them with Ken Burns motion + crossfades on a canvas
 *   3. records the canvas with MediaRecorder into a downloadable video
 * Everything runs locally in the browser — no extra API key required.
 */

const DURATIONS = [
  { id: 3, label: "3s" },
  { id: 5, label: "5s" },
  { id: 8, label: "8s" },
];

const MOTIONS = [
  { id: "zoom-in", label: "Slow zoom in" },
  { id: "zoom-out", label: "Slow zoom out" },
  { id: "pan-right", label: "Pan right" },
  { id: "pan-left", label: "Pan left" },
] as const;

type MotionId = (typeof MOTIONS)[number]["id"];

interface Keyframe {
  blobUrl: string;
  img: HTMLImageElement;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("frame failed to load"));
    img.src = url;
  });
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function pickMime(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(c)
    ) {
      return c;
    }
  }
  return "";
}

export default function VideoPanel() {
  // Seed from Image Studio hand-off ("Make video") at mount time only.
  const [prompt, setPrompt] = useState<string>(() => {
    try {
      const raw = sessionStorage.getItem("lumina.video.prompt");
      if (raw) {
        sessionStorage.removeItem("lumina.video.prompt");
        const p = JSON.parse(raw) as { prompt?: string };
        return p.prompt ?? "";
      }
    } catch {
      /* ignore */
    }
    return "";
  });
  const [duration, setDuration] = useState(5);
  const [motion, setMotion] = useState<MotionId>("zoom-in");
  const [frameCount, setFrameCount] = useState(3);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputMime, setOutputMime] = useState("");
  const [library, setLibrary] = useState<GeneratedVideo[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        setLibrary(await listVideos());
      } catch {
        /* empty library */
      }
    })();
  }, []);

  const stop = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const render = useCallback(async () => {
    const base = prompt.trim();
    if (!base) {
      setError("Describe your scene first.");
      return;
    }
    if (busy) return;
    if (typeof MediaRecorder === "undefined") {
      setError("This browser can't record video — try Chrome or Edge.");
      return;
    }

    setError(null);
    setBusy(true);
    cancelledRef.current = false;
    setOutputUrl(null);
    setProgress(0);

    const seed = Math.floor(Math.random() * 999999);
    const canvas = canvasRef.current;
    if (!canvas) return;

    const W = 1280;
    const H = 720;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Canvas unavailable.");
      setBusy(false);
      return;
    }

    const keyframes: Keyframe[] = [];

    try {
      /* 1 — generate keyframes */
      const n = Math.min(6, Math.max(2, frameCount));
      for (let i = 0; i < n; i++) {
        if (cancelledRef.current) throw new Error("cancelled");
        setStage(`Generating keyframe ${i + 1} of ${n}…`);
        setProgress(0.05 + (i / n) * 0.45);

        const framePrompt = `${base}, cinematic still ${i + 1}/${n}, consistent characters and style, 16:9`;

        // The free generator allows one image per ~45s, so each keyframe may
        // need to wait out a cooldown. We surface that as an honest countdown
        // instead of failing the render.
        let img: HTMLImageElement | null = null;
        let attempts = 0;
        while (!img && attempts < 6) {
          attempts++;
          try {
            const url = imageUrl({
              prompt: framePrompt,
              width: W,
              height: H,
              seed: seed + i,
            });
            const blob = await fetchImageBlob(url);
            img = await loadImage(URL.createObjectURL(blob));
          } catch (e) {
            const waitSec =
              e instanceof ImageBusyError ? e.retryAfterSec : 15;
            if (attempts >= 6) {
              throw new Error(
                `Could not generate keyframe ${i + 1} — the generator stayed busy. Try again.`,
              );
            }
            // live countdown while waiting for the next slot
            for (let s = waitSec; s > 0; s--) {
              if (cancelledRef.current) throw new Error("cancelled");
              setStage(
                `Generator busy — keyframe ${i + 1}/${n} in ${s}s (free tier allows 1 image / 45s)`,
              );
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }
        if (!img) throw new Error("cancelled");
        keyframes.push({ blobUrl: "", img });
      }

      if (cancelledRef.current) throw new Error("cancelled");

      /* 2 — record the animated canvas */
      setStage("Rendering animation…");
      setProgress(0.55);

      const mime = pickMime();
      if (!mime) {
        throw new Error("No supported video encoder found in this browser.");
      }

      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: 6_000_000,
      });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      const finished = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new Error("recording failed"));
      });

      recorder.start(200);

      const perFrame = (duration * 1000) / keyframes.length;
      const startedAt = performance.now();
      const total = duration * 1000;

      await new Promise<void>((resolve) => {
        const tick = () => {
          if (cancelledRef.current) {
            resolve();
            return;
          }
          const elapsed = performance.now() - startedAt;
          const t = Math.min(1, elapsed / total);
          setProgress(0.55 + t * 0.42);

          const idx = Math.min(
            keyframes.length - 1,
            Math.floor(elapsed / perFrame),
          );
          const localT = Math.min(
            1,
            (elapsed - idx * perFrame) / perFrame,
          );

          const cur = keyframes[idx];
          const next = keyframes[Math.min(keyframes.length - 1, idx + 1)];

          drawKenBurns(ctx, W, H, cur.img, motion, easeInOut(localT));

          // crossfade to next frame in the last 18% of each segment
          if (next && localT > 0.82 && idx < keyframes.length - 1) {
            const fade = (localT - 0.82) / 0.18;
            ctx.globalAlpha = fade;
            drawKenBurns(ctx, W, H, next.img, motion, 0);
            ctx.globalAlpha = 1;
          }

          if (elapsed >= total || cancelledRef.current) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      recorder.stop();
      await finished;
      setProgress(1);

      if (cancelledRef.current) {
        setStage("Cancelled");
        setBusy(false);
        return;
      }

      const blob = new Blob(chunks, { type: mime });
      const outUrl = URL.createObjectURL(blob);
      setOutputUrl(outUrl);
      setOutputMime(mime);
      setStage("Done — preview ready");

      const record: GeneratedVideo = {
        id: uid(),
        prompt: base,
        url: outUrl,
        frames: keyframes.length,
        durationSec: duration,
        createdAt: Date.now(),
      };
      setLibrary((l) => [record, ...l]);
      try {
        await putVideo(record);
      } catch {
        /* non-fatal */
      }
    } catch (e) {
      if (e instanceof Error && e.message !== "cancelled") {
        setError(e.message);
        setStage("");
      } else {
        setStage("Cancelled");
      }
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }, [prompt, busy, duration, frameCount, motion]);

  const download = useCallback(
    (url: string, id: string) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = `lumina-video-${id.slice(0, 6)}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [],
  );

  const removeVideo = useCallback(
    async (id: string) => {
      setLibrary((l) => l.filter((v) => v.id !== id));
      try {
        await deleteVideo(id);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* controls */}
        <div className="scroll-area w-full shrink-0 border-b p-5 lg:w-[352px] lg:border-b-0 lg:border-r">
          <h2 className="mb-1 text-xl font-extrabold">
            Video <span className="brand-text">Lab</span>
          </h2>
          <p className="mb-4 text-xs" style={{ color: "var(--muted)" }}>
            Lumino paints your keyframes, then animates and records a real clip
            you can download.
          </p>

          <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            Scene prompt
          </label>
          <textarea
            className="textarea min-h-[110px] resize-y"
            placeholder="A drone shot over a neon city at night, rain, slow cinematic drift…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Duration
              </label>
              <select
                className="input"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {DURATIONS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Keyframes
              </label>
              <select
                className="input"
                value={frameCount}
                onChange={(e) => setFrameCount(Number(e.target.value))}
              >
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} frames
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label className="mb-1.5 mt-3 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            Camera motion
          </label>
          <select
            className="input"
            value={motion}
            onChange={(e) => setMotion(e.target.value as MotionId)}
          >
            {MOTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className="btn btn-primary flex-1 py-2.5"
              onClick={() => void render()}
              disabled={busy || !prompt.trim()}
            >
              {busy ? "Rendering…" : "🎬 Render video"}
            </button>
            {busy && (
              <button type="button" className="btn" onClick={stop} aria-label="Cancel render">
                ■
              </button>
            )}
          </div>

          {(busy || stage) && (
            <div className="mt-3">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
              </div>
              <p className="mt-1.5 text-[0.7rem]" style={{ color: "var(--muted)" }}>
                {stage || "Working…"}
              </p>
            </div>
          )}

          {error && (
            <div
              className="mt-3 rounded-xl border px-3 py-2 text-xs"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}
        </div>

        {/* stage */}
        <div className="scroll-area min-h-0 flex-1 p-5">
          <div className="mx-auto max-w-4xl">
            <canvas ref={canvasRef} className="hidden" />

            <div
              className="glass relative flex min-h-[240px] items-center justify-center overflow-hidden rounded-3xl"
              style={{ aspectRatio: "16/9" }}
            >
              {outputUrl ? (
                <video
                  ref={previewRef}
                  src={outputUrl}
                  controls
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="px-6 text-center">
                  <div
                    className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-white"
                    style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="5" width="14" height="14" rx="3" />
                      <path d="m16 10 6-3.5v11L16 14" />
                    </svg>
                  </div>
                  <p className="text-sm font-semibold">
                    {busy ? stage || "Rendering…" : "Your clip will appear here"}
                  </p>
                  <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                    {busy
                      ? "Keep this tab open while Lumino renders."
                      : "Give Lumino a scene, pick a duration and press Render."}
                  </p>
                </div>
              )}
            </div>

            {outputUrl && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => download(outputUrl, uid())}
                >
                  ⬇ Download clip
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void render()}
                  disabled={busy || !prompt.trim()}
                >
                  ↻ Render again
                </button>
              </div>
            )}

            {library.length > 0 && (
              <>
                <div className="mt-7 flex items-center justify-between">
                  <h3 className="text-sm font-bold">
                    Renders <span className="pill ml-1">{library.length}</span>
                  </h3>
                </div>
                <div className="mt-3 space-y-2">
                  {library.map((v) => (
                    <div
                      key={v.id}
                      className="glass card-hover flex items-center gap-3 rounded-2xl px-3 py-2.5"
                    >
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm text-white"
                        style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}
                      >
                        ▶
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold">{v.prompt}</p>
                        <p className="text-[0.65rem]" style={{ color: "var(--muted)" }}>
                          {v.frames} frames · {v.durationSec}s ·{" "}
                          {new Date(v.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => download(v.url, v.id)}
                      >
                        ⬇
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void removeVideo(v.id)}
                        aria-label="Delete render"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <p className="mt-4 text-center text-[0.65rem]" style={{ color: "var(--muted)" }}>
              {outputMime ? `Encoder: ${outputMime}` : "Encoder: browser default"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Draws one image with the chosen camera motion at progress `t` (0→1). */
function drawKenBurns(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  img: HTMLImageElement,
  motion: MotionId,
  t: number,
) {
  // cover-fit source
  const ir = img.width / img.height;
  const cr = W / H;
  let sw = img.width;
  let sh = img.height;
  if (ir > cr) sw = img.height * cr;
  else sh = img.width / cr;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;

  let zoom = 1;
  let ox = 0;
  const oy = 0;

  switch (motion) {
    case "zoom-in":
      zoom = 1 + 0.14 * t;
      break;
    case "zoom-out":
      zoom = 1.14 - 0.14 * t;
      break;
    case "pan-right":
      zoom = 1.1;
      ox = (t - 0.5) * 0.09 * W;
      break;
    case "pan-left":
      zoom = 1.1;
      ox = (0.5 - t) * 0.09 * W;
      break;
  }

  const dw = W * zoom;
  const dh = H * zoom;
  const dx = (W - dw) / 2 + ox;
  const dy = (H - dh) / 2 + oy;

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}
