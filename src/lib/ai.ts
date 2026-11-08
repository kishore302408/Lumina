/**
 * Lumino Agent — model layer.
 *
 * Every provider implements the same two functions (chat + stream), so the
 * app never talks to a vendor directly. Swap the provider in one place and
 * every column (chat, voice, image, video) keeps working.
 *
 * Default: keyless free endpoints (no signup, no secrets).
 * Paid/bring-your-own-key providers drop in here later without UI changes.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  keyless: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "lumina-free", label: "Lumina Free (keyless)", keyless: true },
];

export const IMAGE_MODELS = [
  { id: "flux", label: "Flux — photoreal" },
  { id: "turbo", label: "Turbo — fast" },
];

/** Text completion with streaming via SSE (OpenAI-compatible wire format). */
export async function* streamChat(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number } = {},
): AsyncGenerator<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages,
      model: opts.model ?? "openai",
      temperature: opts.temperature ?? 0.8,
    }),
  });

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) detail = String(j.error);
    } catch {
      /* keep status */
    }
    throw new Error(`Lumino could not reach its brain (${detail})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta: string =
            json?.choices?.[0]?.delta?.content ??
            json?.choices?.[0]?.message?.content ??
            "";
          if (delta) yield delta;
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
}

/** Non-streaming helper (used by voice mode for a quick full reply). */
export async function chatOnce(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number } = {},
): Promise<string> {
  let out = "";
  for await (const chunk of streamChat(messages, opts)) out += chunk;
  return out;
}

/** Build a keyless image-generation URL (fetched server-side to avoid CORS). */
export function imageUrl(params: {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  model?: string;
}): string {
  const q = new URLSearchParams({
    prompt: params.prompt,
    width: String(params.width),
    height: String(params.height),
    seed: String(params.seed),
    nologo: "true",
    referrer: "lumina-agent",
    model: params.model ?? "flux",
  });
  return `/api/image?${q.toString()}`;
}

export class ImageBusyError extends Error {
  retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = "ImageBusyError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Fetch an image and return a blob (throws ImageBusyError during cooldown). */
export async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (res.ok) return res.blob();

  let retryAfterSec = 45;
  let detail = `image generation failed (HTTP ${res.status})`;
  try {
    const j = await res.json();
    if (typeof j?.retryAfterSec === "number") retryAfterSec = j.retryAfterSec;
    if (typeof j?.error === "string") detail = j.error;
  } catch {
    /* keep defaults */
  }
  throw new ImageBusyError(detail, retryAfterSec);
}

export const SUGGESTED_IMAGE_STYLES = [
  "cinematic lighting, 35mm, shallow depth of field",
  "isometric 3d render, soft studio light, pastel palette",
  "watercolor illustration, paper texture, gentle colors",
  "cyberpunk neon, rain-slick streets, moody atmosphere",
  "minimal vector art, flat design, bold geometry",
];
