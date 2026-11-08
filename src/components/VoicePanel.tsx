"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chatOnce, type ChatMessage } from "@/lib/ai";
import { DEFAULT_PERSONAS } from "@/lib/types";

type Turn = { id: string; who: "you" | "lumino"; text: string };

/** Minimal typings for the non-standard Web Speech API. */
interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechResult };
}

const SpeechRecognitionCtor =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>)
        .webkitSpeechRecognition ??
      (window as unknown as Record<string, unknown>).SpeechRecognition)
    : undefined;

export default function VoicePanel() {
  const [supported] = useState(() => Boolean(SpeechRecognitionCtor));
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const recRef = useRef<{ start: () => void; stop: () => void; abort: () => void } | null>(null);
  const wantListenRef = useRef(false);

  /* ---- TTS voices ---- */
  useEffect(() => {
    const loadVoices = () => {
      const v = window.speechSynthesis?.getVoices() ?? [];
      if (v.length) {
        setVoices(v);
        const preferred =
          v.find((x) => /en[-_]/i.test(x.lang) && /female|zira|aria|jenny|samantha/i.test(x.name)) ??
          v.find((x) => /^en/i.test(x.lang)) ??
          v[0];
        setVoiceName((prev) => prev || preferred.name);
      }
    };
    loadVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis?.removeEventListener("voiceschanged", loadVoices);
    };
  }, []);

  /* ---- waveform visualizer ---- */
  const drawWave = useCallback(() => {
    const render = () => {
      const canvas = canvasRef.current;
      const analyser = analyserRef.current;
      if (!canvas || !analyser) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);

      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue("--accent").trim() || "#8b7dff";
      const accent2 = style.getPropertyValue("--accent-2").trim() || "#2ee8f0";

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, accent2);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.2;
      ctx.beginPath();

      const slice = w / (data.length - 1);
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128;
        const y = (v * h) / 2;
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * slice, y);
      }
      ctx.stroke();

      // mirrored soft fill
      ctx.globalAlpha = 0.14;
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;

      rafRef.current = requestAnimationFrame(render);
    };
    render();
  }, []);

  const stopMic = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      analyserRef.current = analyser;
      rafRef.current = requestAnimationFrame(drawWave);
      return true;
    } catch {
      setError("Microphone access denied. Allow the mic in your browser.");
      return false;
    }
  }, [drawWave]);

  /* ---- speak reply ---- */
  const speak = useCallback(
    (text: string) => {
      if (muted || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const clean = text
        .replace(/```[\s\S]*?```/g, " code block omitted ")
        .replace(/[*_#`>]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();
      if (!clean) return;
      const u = new SpeechSynthesisUtterance(clean.slice(0, 1200));
      const v = voices.find((x) => x.name === voiceName);
      if (v) u.voice = v;
      u.rate = 1.03;
      u.pitch = 1.02;
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    },
    [muted, voiceName, voices],
  );

  /* ---- ask the model ---- */
  const ask = useCallback(
    async (prompt: string) => {
      const youTurn: Turn = { id: `${Date.now()}u`, who: "you", text: prompt };
      setTurns((t) => [...t, youTurn]);
      setBusy(true);
      setError(null);
      try {
        const history: ChatMessage[] = [
          {
            role: "system",
            content:
              DEFAULT_PERSONAS[0].system +
              "\n\nThis is a VOICE conversation. Reply with plain spoken prose: " +
              "no markdown, no code blocks, no bullet symbols. Keep replies under 80 words unless asked for more.",
          },
          ...turns.slice(-8).map((t) => ({
            role: (t.who === "you" ? "user" : "assistant") as "user" | "assistant",
            content: t.text,
          })),
          { role: "user" as const, content: prompt },
        ];
        const reply = (await chatOnce(history, { temperature: 0.9 })).trim();
        setTurns((t) => [
          ...t,
          { id: `${Date.now()}a`, who: "lumino", text: reply || "(no reply)" },
        ]);
        speak(reply || "(no reply)");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Voice request failed.");
      } finally {
        setBusy(false);
      }
    },
    [turns, speak],
  );

  /* ---- speech recognition loop ---- */
  const stopListening = useCallback(() => {
    wantListenRef.current = false;
    setListening(false);
    setInterim("");
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    stopMic();
  }, [stopMic]);

  const startListening = useCallback(async () => {
    if (busy || listening) return;
    setError(null);

    const micOk = await startMic();
    if (!micOk) return;

    if (!supported || !SpeechRecognitionCtor) {
      setError(
        "Speech recognition isn't supported in this browser — use Chrome or Edge. You can still type below.",
      );
      stopMic();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new (SpeechRecognitionCtor as any)();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    let finalBuffer = "";

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalBuffer += r[0].transcript;
        else interimText += r[0].transcript;
      }
      setInterim((finalBuffer + interimText).trim());
    };

    rec.onerror = (e: { error?: string }) => {
      if (e?.error === "no-speech") return;
      if (e?.error === "aborted") return;
      setError(`Speech recognition error: ${e?.error ?? "unknown"}`);
      wantListenRef.current = false;
      setListening(false);
      stopMic();
    };

    rec.onend = () => {
      const transcript = (finalBuffer || "").trim();
      if (transcript) {
        finalBuffer = "";
        void ask(transcript);
      }
      // auto-continue the conversation loop while engaged
      if (wantListenRef.current) {
        try {
          rec.start();
        } catch {
          wantListenRef.current = false;
          setListening(false);
        }
      } else {
        setListening(false);
        setInterim("");
        stopMic();
      }
    };

    recRef.current = rec;
    wantListenRef.current = true;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError("Could not start the microphone.");
      stopMic();
    }
  }, [busy, listening, supported, startMic, stopMic, ask]);

  useEffect(() => {
    return () => {
      wantListenRef.current = false;
      try {
        recRef.current?.abort();
      } catch {
        /* noop */
      }
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close().catch(() => undefined);
      window.speechSynthesis?.cancel();
    };
  }, []);

  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      if (next) window.speechSynthesis?.cancel();
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scroll-area min-h-0 flex-1 px-4 py-6 sm:px-8">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-6">
          <div className="text-center">
            <h2 className="text-xl font-extrabold">
              Voice <span className="brand-text">Conversation</span>
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
              Tap the mic, speak naturally — Lumino listens, thinks and talks back.
            </p>
          </div>

          {/* waveform */}
          <div
            className="glass w-full rounded-3xl p-5"
            style={{ boxShadow: speaking ? "0 0 44px var(--glow)" : undefined }}
          >
            <canvas ref={canvasRef} className="h-[120px] w-full" />
            <div className="mt-3 flex items-center justify-between text-[0.7rem]" style={{ color: "var(--muted)" }}>
              <span>
                {speaking
                  ? "🔊 Lumino is speaking"
                  : listening
                    ? "🎙 Listening…"
                    : busy
                      ? "⏳ Thinking…"
                      : "Standby"}
              </span>
              <span>{interim ? `"${interim}"` : ""}</span>
            </div>
          </div>

          {/* controls */}
          <div className="flex items-center gap-5">
            <button
              type="button"
              className="btn h-12 w-12 !rounded-full !p-0 text-lg"
              onClick={toggleMute}
              aria-label={muted ? "Unmute voice" : "Mute voice"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? "🔇" : "🔊"}
            </button>

            <button
              type="button"
              className={`mic-btn ${listening ? "listening" : ""}`}
              onClick={() => (listening ? stopListening() : void startListening())}
              disabled={busy}
              aria-label={listening ? "Stop listening" : "Start listening"}
            >
              {busy ? (
                <span className="spinner !h-8 !w-8 !border-[3px]" />
              ) : (
                <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
                </svg>
              )}
            </button>

            <button
              type="button"
              className="btn h-12 w-12 !rounded-full !p-0"
              onClick={() => {
                stopListening();
                window.speechSynthesis?.cancel();
                setTurns([]);
              }}
              aria-label="Reset conversation"
              title="Reset"
            >
              ↺
            </button>
          </div>

          {error && (
            <div
              className="w-full rounded-xl border px-3 py-2 text-center text-xs"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}

          {!supported && !error && (
            <div
              className="w-full rounded-xl border px-3 py-2 text-center text-xs"
              style={{ borderColor: "var(--border-strong)", color: "var(--muted)" }}
            >
              For voice input use Chrome or Edge. Playback still works everywhere.
            </div>
          )}

          {/* voice settings */}
          <div className="glass w-full rounded-2xl p-4">
            <label className="mb-1.5 block text-[0.65rem] font-bold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
              Lumino&apos;s voice
            </label>
            <select
              className="input"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
            >
              {!voices.length && <option value="">(loading voices…)</option>}
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} — {v.lang}
                </option>
              ))}
            </select>
          </div>

          {/* transcript */}
          <div className="w-full space-y-3 pb-4">
            {turns.length === 0 && (
              <p className="text-center text-xs" style={{ color: "var(--muted)" }}>
                Your conversation transcript will appear here.
              </p>
            )}
            {turns.map((t) => (
              <div
                key={t.id}
                className={`float-in flex ${t.who === "you" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[0.9rem] ${
                    t.who === "you" ? "msg-user" : "msg-ai"
                  }`}
                >
                  <div className="mb-0.5 text-[0.6rem] font-bold uppercase tracking-wider opacity-70">
                    {t.who === "you" ? "You" : "Lumino"}
                  </div>
                  {t.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
