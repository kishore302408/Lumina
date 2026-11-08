import { NextRequest } from "next/server";

export const maxDuration = 30;

/**
 * Image proxy.
 *
 * The keyless generator allows ~1 image per 45s per IP. We remember the next
 * allowed window on the server, fail fast with an honest `retryAfterSec` when
 * it's not open yet, and otherwise fetch upstream once (no long-held sleeps,
 * so serverless time limits are respected).
 */

const GEN_INTERVAL_MS = 46_000;

// Module-level: survives across invocations in the same server instance.
const state = (globalThis as { __luminaImg?: { nextAllowed: number } }).__luminaImg ??
  ((globalThis as { __luminaImg?: { nextAllowed: number } }).__luminaImg = {
    nextAllowed: 0,
  });

function busyResponse(retryAfterSec: number): Response {
  return Response.json(
    {
      error: `The free image generator is on a cooldown of ~45s between images. Retry in ${retryAfterSec}s.`,
      retryAfterSec,
    },
    { status: 429, headers: { "retry-after": String(retryAfterSec) } },
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const prompt = (sp.get("prompt") ?? "").trim().slice(0, 1200);
  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  const clamp = (raw: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const width = clamp(sp.get("width") ?? "", 256, 1536, 1024);
  const height = clamp(sp.get("height") ?? "", 256, 1536, 1024);
  const seed = clamp(sp.get("seed") ?? "", 0, 999999999, Math.floor(Math.random() * 1e6));
  const model = sp.get("model") ?? "flux";

  const now = Date.now();
  if (now < state.nextAllowed) {
    return busyResponse(Math.ceil((state.nextAllowed - now) / 1000));
  }

  const qs = new URLSearchParams({
    prompt,
    width: String(width),
    height: String(height),
    seed: String(seed),
    nologo: "true",
    referrer: "lumina-agent",
    model,
  });

  let upstream: Response;
  try {
    upstream = await fetch(
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${qs.toString()}`,
      { cache: "no-store" },
    );
  } catch {
    // network hiccup: one quick retry
    try {
      upstream = await fetch(
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${qs.toString()}`,
        { cache: "no-store" },
      );
    } catch {
      return Response.json(
        { error: "Image service unreachable", retryAfterSec: 15 },
        { status: 502 },
      );
    }
  }

  if (upstream.status === 402 || upstream.status === 429) {
    // upstream quota — learn the window and tell the client exactly when to come back
    upstream.body?.cancel().catch(() => undefined);
    state.nextAllowed = Date.now() + GEN_INTERVAL_MS;
    return busyResponse(Math.ceil(GEN_INTERVAL_MS / 1000));
  }

  if (!upstream.ok) {
    upstream.body?.cancel().catch(() => undefined);
    return Response.json(
      { error: `Image service error (${upstream.status})`, retryAfterSec: 20 },
      { status: 502 },
    );
  }

  state.nextAllowed = Date.now() + GEN_INTERVAL_MS;

  const buf = await upstream.arrayBuffer();
  const type = upstream.headers.get("content-type") ?? "image/jpeg";

  return new Response(buf, {
    status: 200,
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
