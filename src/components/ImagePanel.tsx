"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteImage, listImages, putImage, uid } from "@/lib/db";
import { fetchImageBlob, imageUrl, ImageBusyError, SUGGESTED_IMAGE_STYLES } from "@/lib/ai";
import type { GeneratedImage } from "@/lib/types";

const RATIOS: { id: string; label: string; w: number; h: number }[] = [
  { id: "square", label: "1:1", w: 1024, h: 1024 },
  { id: "wide", label: "16:9", w: 1280, h: 720 },
  { id: "tall", label: "9:16", w: 720, h: 1280 },
  { id: "photo", label: "3:2", w: 1200, h: 800 },
];

export default function ImagePanel() {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("square");
  const [style, setStyle] = useState(SUGGESTED_IMAGE_STYLES[0]);
  const [negative, setNegative] = useState("");
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 999999));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [gallery, setGallery] = useState<GeneratedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GeneratedImage | null>(null);
  /** seconds until the free generator accepts the next image */
  const [cooldown, setCooldown] = useState(0);

  const objectUrls = useRef(new Map<string, string>());

  useEffect(() => {
    (async () => {
      try {
        const imgs = await listImages();
        setGallery(imgs);
      } catch {
        /* gallery simply starts empty */
      }
    })();
    const urls = objectUrls.current;
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    };
  }, []);

  /* tick the free-tier cooldown down once per second */
  const cooldownActive = cooldown > 0;
  useEffect(() => {
    if (!cooldownActive) return;
    const id = window.setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownActive]);

  const generate = useCallback(async () => {
    const base = prompt.trim();
    if (!base) {
      setError("Describe what you want to see first.");
      return;
    }
    if (busy || cooldown > 0) return;

    setError(null);
    setBusy(true);
    setProgress(0.12);

    const finalPrompt = [base, style, negative ? `avoid: ${negative}` : ""]
      .filter(Boolean)
      .join(", ");
    const r = RATIOS.find((x) => x.id === ratio) ?? RATIOS[0];
    const currentSeed = seed;

    const timer = window.setInterval(() => {
      setProgress((p) => Math.min(0.9, p + 0.05));
    }, 420);

    try {
      const url = imageUrl({
        prompt: finalPrompt,
        width: r.w,
        height: r.h,
        seed: currentSeed,
      });
      const blob = await fetchImageBlob(url);
      setProgress(1);

      // keep a live object URL for instant display
      const objUrl = URL.createObjectURL(blob);
      const record: GeneratedImage = {
        id: uid(),
        prompt: base,
        url: objUrl,
        seed: currentSeed,
        width: r.w,
        height: r.h,
        createdAt: Date.now(),
      };
      objectUrls.current.set(record.id, objUrl);
      setPreview(record);
      setGallery((g) => [record, ...g]);

      // persist metadata (regenerable from prompt+seed) to IndexedDB
      try {
        await putImage({ ...record, url: "" });
      } catch {
        /* non-fatal */
      }

      // free tier allows one image per ~45s — start the local countdown
      setCooldown(46);
      setSeed(Math.floor(Math.random() * 999999));
    } catch (e) {
      if (e instanceof ImageBusyError) {
        setCooldown(Math.max(1, e.retryAfterSec));
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : "Generation failed.");
      }
    } finally {
      window.clearInterval(timer);
      setBusy(false);
      setProgress(0);
    }
  }, [prompt, style, negative, ratio, seed, busy, cooldown]);

  const removeImage = useCallback(
    async (id: string) => {
      const url = objectUrls.current.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(id);
      }
      setGallery((g) => g.filter((x) => x.id !== id));
      if (preview?.id === id) setPreview(null);
      try {
        await deleteImage(id);
      } catch {
        /* ignore */
      }
    },
    [preview],
  );

  const regenerate = useCallback(
    (img: GeneratedImage) => {
      setPrompt(img.prompt);
      setSeed(img.seed);
      window.setTimeout(() => void generate(), 60);
    },
    [generate],
  );

  const download = useCallback(
    async (img: GeneratedImage) => {
      try {
        const href =
          img.url ||
          imageUrl({
            prompt: img.prompt,
            width: img.width,
            height: img.height,
            seed: img.seed,
          });
        const a = document.createElement("a");
        a.href = href;
        a.download = `lumina-${img.seed}.jpg`;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        setError("Download failed.");
      }
    },
    [],
  );

  const sendToVideo = (img: GeneratedImage) => {
    try {
      sessionStorage.setItem(
        "lumina.video.prompt",
        JSON.stringify({ prompt: img.prompt, seed: img.seed }),
      );
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent("lumina:goto", { detail: { panel: "video" } }),
    );
    alert(
      "Saved as the video seed. Open the Video column — your prompt will be pre-filled.",
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* controls */}
        <div className="scroll-area w-full shrink-0 border-b p-5 lg:w-[352px] lg:border-b-0 lg:border-r">
          <h2 className="mb-1 text-xl font-extrabold">
            Image <span className="brand-text">Studio</span>
          </h2>
          <p className="mb-4 text-xs" style={{ color: "var(--muted)" }}>
            Turn a sentence into art. Every image is saved to your gallery.
          </p>

          <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            Prompt
          </label>
          <textarea
            className="textarea min-h-[110px] resize-y"
            placeholder="A lantern-lit street in the rain, neon reflections, cinematic…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
            }}
          />

          <div className="mt-3 flex flex-wrap gap-1.5">
            {SUGGESTED_IMAGE_STYLES.map((s) => (
              <button
                key={s}
                type="button"
                className="pill cursor-pointer transition hover:border-[var(--accent)]"
                style={
                  style === s
                    ? { borderColor: "var(--accent)", color: "var(--text)" }
                    : undefined
                }
                onClick={() => setStyle(s)}
              >
                {s.split(",")[0]}
              </button>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Aspect
              </label>
              <select className="input" value={ratio} onChange={(e) => setRatio(e.target.value)}>
                {RATIOS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} ({r.w}×{r.h})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Seed
              </label>
              <div className="flex gap-1.5">
                <input
                  className="input"
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value) || 0)}
                />
                <button
                  type="button"
                  className="btn shrink-0"
                  onClick={() => setSeed(Math.floor(Math.random() * 999999))}
                  aria-label="Randomize seed"
                  title="Randomize"
                >
                  🎲
                </button>
              </div>
            </div>
          </div>

          <div className="mt-3">
            <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Negative prompt (optional)
            </label>
            <input
              className="input"
              placeholder="blurry, watermark, low quality…"
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary mt-4 w-full py-2.5"
            onClick={() => void generate()}
            disabled={busy || cooldown > 0 || !prompt.trim()}
          >
            {busy
              ? "Generating…"
              : cooldown > 0
                ? `⏳ Free tier cools down · ${cooldown}s`
                : "✦ Generate image"}
          </button>

          {busy && (
            <div className="progress-track mt-3">
              <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
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

        {/* preview + gallery */}
        <div className="scroll-area min-h-0 flex-1 p-5">
          {preview ? (
            <div className="float-in mx-auto max-w-3xl">
              <div className="glass overflow-hidden rounded-3xl">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview.url}
                  alt={preview.prompt}
                  className="max-h-[46vh] w-full object-contain"
                  style={{ background: "var(--panel-2)" }}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-xs" style={{ color: "var(--muted)" }}>
                  {preview.prompt} · seed {preview.seed}
                </p>
                <div className="flex gap-2">
                  <button type="button" className="btn" onClick={() => void download(preview)}>
                    ⬇ Download
                  </button>
                  <button type="button" className="btn" onClick={() => void regenerate(preview)}>
                    ↻ Reuse seed
                  </button>
                  <button type="button" className="btn" onClick={() => sendToVideo(preview)}>
                    ▶ Make video
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col items-center justify-center gap-3 py-16 text-center">
              <div
                className="flex h-14 w-14 items-center justify-center rounded-2xl text-white"
                style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="8.5" cy="8.5" r="1.7" />
                  <path d="m21 15-4.6-4.6a2 2 0 0 0-2.8 0L4 20" />
                </svg>
              </div>
              <p className="text-sm font-semibold">Your canvas is blank</p>
              <p className="max-w-sm text-xs" style={{ color: "var(--muted)" }}>
                Write a prompt on the left and hit Generate. Result lands here in seconds.
              </p>
            </div>
          )}

          {gallery.length > 0 && (
            <>
              <div className="mx-auto mt-7 flex max-w-3xl items-center justify-between">
                <h3 className="text-sm font-bold">
                  Gallery <span className="pill ml-1">{gallery.length}</span>
                </h3>
              </div>
              <div className="mx-auto mt-3 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3">
                {gallery.map((img) => {
                  const src =
                    img.url ||
                    imageUrl({
                      prompt: img.prompt,
                      width: img.width,
                      height: img.height,
                      seed: img.seed,
                    });
                  return (
                    <div
                      key={img.id}
                      className="glass card-hover group relative overflow-hidden rounded-2xl"
                      onClick={() => setPreview(img)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setPreview(img);
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt={img.prompt} className="aspect-square w-full object-cover" />
                      <button
                        type="button"
                        className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-full text-xs group-hover:flex"
                        style={{ background: "rgba(0,0,0,.62)", color: "#fff" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeImage(img.id);
                        }}
                        aria-label="Delete image"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
