"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteConversation,
  listConversations,
  listMemories,
  messagesFor,
  migrateMessages,
  putConversation,
  putMessage,
  uid,
} from "@/lib/db";
import { streamChat, type ChatMessage } from "@/lib/ai";
import { DEFAULT_PERSONAS, type Conversation, type Message } from "@/lib/types";

/* ---------- tiny markdown renderer (no deps) ---------- */

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // code, bold, italic, links
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      nodes.push(
        <a key={k} href={mm?.[2]} target="_blank" rel="noreferrer noopener">
          {mm?.[1]}
        </a>,
      );
    } else {
      nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="md text-[0.92rem] leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <pre key={i}>
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.type === "heading") {
          const Tag = (["h1", "h2", "h3"] as const)[b.level - 1] ?? "h3";
          return <Tag key={i}>{renderInline(b.text, `h${i}`)}</Tag>;
        }
        if (b.type === "ul" || b.type === "ol") {
          const List = b.type === "ul" ? "ul" : "ol";
          return (
            <List key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{renderInline(it, `l${i}-${j}`)}</li>
              ))}
            </List>
          );
        }
        if (b.type === "quote") {
          return <blockquote key={i}>{renderInline(b.text, `q${i}`)}</blockquote>;
        }
        if (b.type === "hr") return <div key={i} className="divider my-2" />;
        if (b.type === "table") {
          return (
            <div key={i} className="my-2 overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    {b.head.map((h, j) => (
                      <th key={j}>{renderInline(h, `th${i}-${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>{renderInline(cell, `td${i}-${ri}-${ci}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={i}>{renderInline(b.text, `p${i}`)}</p>;
      })}
    </div>
  );
}

type Block =
  | { type: "code"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "hr" }
  | { type: "p"; text: string };

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");

function splitTableRow(l: string): string[] {
  return l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function splitBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push({ type: "code", text: buf.join("\n") + (lang ? "" : "") });
      continue;
    }

    if (/^\s*#{1,3}\s+/.test(line)) {
      const level = (/^\s*(#{1,3})/.exec(line)?.[1] ?? "#").length;
      out.push({
        type: "heading",
        level,
        text: line.replace(/^\s*#{1,3}\s+/, ""),
      });
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push({ type: "quote", text: buf.join(" ") });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      out.push({ type: "ol", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // markdown table: header row, separator row, then body rows
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push({ type: "table", head, rows });
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*(```|#{1,3}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

/* ---------- panel ---------- */

const STARTERS = [
  "What can you do?",
  "Plan my day in 5 bullet points",
  "Write a haiku about glowing cities",
];

export default function ChatPanel() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [personaId, setPersonaId] = useState("lumino");
  const [memories, setMemories] = useState<{ id: string; content: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* boot: conversations + memories */
  useEffect(() => {
    (async () => {
      try {
        await migrateMessages();
        const [c, m] = await Promise.all([listConversations(), listMemories()]);
        setConvs(c);
        setMemories(m);
        if (c.length > 0) {
          setActiveId(c[0].id);
          setMessages(await messagesFor(c[0].id));
        }
      } catch {
        setError("Local database unavailable — history will not persist.");
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streamText]);

  const newConversation = useCallback(async () => {
    const c: Conversation = {
      id: uid(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await putConversation(c);
    } catch {
      /* non-fatal */
    }
    setConvs((prev) => [c, ...prev]);
    setActiveId(c.id);
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages(await messagesFor(id));
    setError(null);
  }, []);

  const removeConversation = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
      } catch {
        /* ignore */
      }
      const next = convs.filter((c) => c.id !== id);
      setConvs(next);
      if (activeId === id) {
        if (next.length > 0) {
          setActiveId(next[0].id);
          setMessages(await messagesFor(next[0].id));
        } else {
          setActiveId(null);
          setMessages([]);
        }
      }
    },
    [convs, activeId],
  );

  const persona = DEFAULT_PERSONAS.find((p) => p.id === personaId) ?? DEFAULT_PERSONAS[0];

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || busy) return;

      setError(null);
      setInput("");

      // ensure an active conversation exists
      let convId = activeId;
      if (!convId) {
        const c: Conversation = {
          id: uid(),
          title: text.slice(0, 42),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        try {
          await putConversation(c);
        } catch {
          /* ignore */
        }
        setConvs((prev) => [c, ...prev]);
        setActiveId(c.id);
        convId = c.id;
      }

      const userMsg: Message = {
        id: uid(),
        conversationId: convId,
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      try {
        await putMessage(userMsg);
      } catch {
        /* ignore */
      }

      // title the conversation on first exchange
      if (nextMessages.length === 1) {
        const title = text.slice(0, 42) + (text.length > 42 ? "…" : "");
        setConvs((prev) =>
          prev.map((c) =>
            c.id === convId ? { ...c, title, updatedAt: Date.now() } : c,
          ),
        );
        const found = convs.find((c) => c.id === convId);
        if (found) {
          try {
            await putConversation({ ...found, title, updatedAt: Date.now() });
          } catch {
            /* ignore */
          }
        }
      }

      setBusy(true);
      setStreamText("");

      const wire: ChatMessage[] = [
        {
          role: "system",
          content:
            persona.system +
            (memories.length
              ? "\n\nKnown facts about the user:\n" +
                memories.map((m) => `- ${m.content}`).join("\n")
              : ""),
        },
        ...nextMessages.slice(-30).map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      try {
        let acc = "";
        for await (const chunk of streamChat(wire)) {
          acc += chunk;
          setStreamText(acc);
        }

        const aiMsg: Message = {
          id: uid(),
          conversationId: convId,
          role: "assistant",
          content: acc || "_(empty response)_",
          createdAt: Date.now(),
        };
        setMessages((prev) => [...prev, aiMsg]);
        setStreamText("");
        try {
          await putMessage(aiMsg);
          const found = (await listConversations()).find(
            (c) => c.id === convId,
          );
          if (found) {
            const updated = { ...found, updatedAt: Date.now() };
            await putConversation(updated);
            setConvs((prev) =>
              prev
                .map((c) => (c.id === convId ? updated : c))
                .sort((a, b) => b.updatedAt - a.updatedAt),
            );
          }
        } catch {
          /* ignore */
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setBusy(false);
        setStreamText("");
        inputRef.current?.focus();
      }
    },
    [input, busy, activeId, messages, persona, memories, convs],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* history rail */}
      <div className="glass-2 hidden w-[236px] shrink-0 flex-col border-r p-3 lg:flex">
        <button type="button" className="btn btn-primary mb-3" onClick={() => void newConversation()}>
          + New chat
        </button>
        <div className="scroll-area min-h-0 flex-1 space-y-1.5 pr-1">
          {convs.length === 0 && (
            <p className="px-1 py-3 text-xs" style={{ color: "var(--muted)" }}>
              No conversations yet.
            </p>
          )}
          {convs.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-xl border px-2.5 py-2 text-xs transition ${
                c.id === activeId ? "border-[var(--accent)]" : ""
              }`}
              style={{
                background: c.id === activeId ? "var(--accent-soft)" : "transparent",
                cursor: "pointer",
              }}
              onClick={() => void openConversation(c.id)}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
              <button
                type="button"
                aria-label="Delete conversation"
                className="hidden rounded-md px-1 group-hover:block"
                style={{ color: "var(--muted)" }}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeConversation(c.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
            Persona
          </p>
          <select
            className="input"
            value={personaId}
            onChange={(e) => setPersonaId(e.target.value)}
          >
            {DEFAULT_PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* thread */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="scroll-area min-h-0 flex-1 px-4 py-5 sm:px-8">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.length === 0 && !streamText && (
              <div className="float-in mt-6 flex flex-col items-center gap-4 text-center">
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-3xl text-2xl font-black text-white shadow-xl"
                  style={{ background: "linear-gradient(135deg,var(--accent),var(--accent-2))" }}
                >
                  L
                </div>
                <h2 className="text-2xl font-extrabold">
                  Hi, I&apos;m <span className="brand-text">Lumino Agent</span>
                </h2>
                <p className="max-w-md text-sm" style={{ color: "var(--muted)" }}>
                  Your companion for conversation, voice, image and video — plus
                  optional control of your desktop when the local bridge is running.
                </p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="btn card-hover"
                      onClick={() => void send(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <div
                key={m.id}
                className={`float-in flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${
                    m.role === "user" ? "msg-user" : "msg-ai"
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2 text-[0.63rem] font-bold uppercase tracking-wider opacity-70">
                    {m.role === "user" ? "You" : "Lumino"}
                  </div>
                  {m.role === "assistant" ? (
                    <Markdown text={m.content} />
                  ) : (
                    <div className="whitespace-pre-wrap text-[0.92rem] leading-relaxed">
                      {m.content}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {streamText && (
              <div className="flex justify-start">
                <div className="msg-ai max-w-[85%] rounded-2xl px-4 py-2.5">
                  <div className="mb-1 text-[0.63rem] font-bold uppercase tracking-wider opacity-70">
                    Lumino
                  </div>
                  <Markdown text={streamText} />
                  <span className="cursor-blink" />
                </div>
              </div>
            )}

            {busy && !streamText && (
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                <span className="spinner" /> Lumino is thinking…
              </div>
            )}

            {error && (
              <div
                className="rounded-xl border px-3 py-2 text-xs"
                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
              >
                {error}
              </div>
            )}
          </div>
        </div>

        {/* composer */}
        <div className="shrink-0 px-4 pb-5 sm:px-8">
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border p-2"
            style={{ background: "var(--panel)", borderColor: "var(--border-strong)" }}>
            <textarea
              ref={inputRef}
              className="textarea resize-none border-0 bg-transparent focus:shadow-none"
              rows={1}
              placeholder="Message Lumino Agent…  (Enter to send, Shift+Enter for newline)"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 170) + "px";
              }}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-primary h-10 w-10 shrink-0 !p-0 text-lg"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              aria-label="Send message"
            >
              ➤
            </button>
          </div>
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[0.65rem]" style={{ color: "var(--muted)" }}>
            Lumino can make mistakes. Verify important information.
            {memories.length > 0 && ` · ${memories.length} saved memories`}
          </p>
        </div>
      </div>
    </div>
  );
}
