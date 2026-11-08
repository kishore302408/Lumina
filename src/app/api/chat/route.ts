import { NextRequest } from "next/server";

const UPSTREAM = "https://text.pollinations.ai/openai";

interface WireMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function isMessage(m: unknown): m is WireMessage {
  if (!m || typeof m !== "object") return false;
  const mm = m as Record<string, unknown>;
  return (
    typeof mm.content === "string" &&
    (mm.role === "system" || mm.role === "user" || mm.role === "assistant")
  );
}

export async function POST(req: NextRequest) {
  let body: {
    messages?: unknown;
    model?: unknown;
    temperature?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const valid = messages.filter(isMessage);

  if (valid.length === 0) {
    return Response.json({ error: "No messages supplied" }, { status: 400 });
  }

  // Hard cap so a client can't stream an unbounded prompt through the proxy.
  const trimmed = valid.slice(-40);

  const payload = {
    model: typeof body.model === "string" ? body.model : "openai",
    messages: trimmed,
    temperature:
      typeof body.temperature === "number" &&
      body.temperature >= 0 &&
      body.temperature <= 2
        ? body.temperature
        : 0.8,
    stream: true,
  };

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    return Response.json(
      { error: "Could not reach the Lumino brain service" },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: `Brain service error: ${detail.slice(0, 300) || upstream.status}` },
      { status: 502 },
    );
  }

  // Pass the SSE stream straight through to the client.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
