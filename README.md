# Lumina — Lumino Agent

A personal AI companion with four dedicated columns — **Chat**, **Voice**, **Image**, and **Video** — plus a permission-gated **Desktop Bridge** for local machine access, a persistent **database**, **dark/light mode**, and an intro animation that presents the name **Lumino Agent**.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js) ![React](https://img.shields.io/badge/React-19-61dafb?logo=react) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript) ![Tailwind](https://img.shields.io/badge/Tailwind-4-38b2ac?logo=tailwindcss)

---

## Features

| Column | What it does |
| --- | --- |
| **Chat** | Streaming LLM conversation with markdown (headings, lists, code, **tables**), conversation history, personas, and long-term memory injection. |
| **Voice** | Real microphone input with a live waveform visualizer, Web Speech recognition, and text-to-speech replies with selectable voices. |
| **Image** | Text-to-image studio: prompt, style presets, aspect ratio, seed control, negative prompt, preview, and a persistent gallery. |
| **Video** | Real rendered clips: generates keyframes, animates them (Ken Burns + crossfades) on a canvas, and records a downloadable **VP9/WebM** via `MediaRecorder`. |
| **Agent** | Connects to the local Desktop Bridge for system info, installed apps, file browsing, and browser-tab context — every capability **denied by default** until you grant it. |
| **Settings** | Long-term memories, personas, data counts, full JSON export, and one-click wipe of local data. |

Also included:

- **Intro animation** — "LUMINO AGENT" letter-by-letter splash (skippable, once per session).
- **Dark / light theme** — persisted, no flash on load.
- **Database** — IndexedDB (`lumina-agent`) storing conversations, messages, memories, images, videos, and settings.
- **Swappable model layer** — `src/lib/ai.ts` exposes one provider interface; keyless free endpoints today, paid or custom-trained models later without UI changes.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

### Production build

```bash
npm run build
npm start
```

### Desktop bridge (optional)

The website itself cannot touch your desktop — browsers block that by design. Lumina uses a tiny local process you control:

```bash
npm run agent      # starts on http://127.0.0.1:7311
```

Then open the **Agent** column and grant permissions (apps / files / browser tabs) individually. Revoke them at any time. The bridge:

- listens on `127.0.0.1` only,
- rejects requests from unknown origins,
- starts with **all capabilities denied**,
- only launches Start-menu shortcuts (`.lnk`), never arbitrary executables.

## Architecture

```
src/
  app/
    page.tsx               # app shell: rail nav, theme, bridge polling
    layout.tsx             # metadata ("Lumino Agent") + theme bootstrap script
    globals.css            # design system, themes, intro styles
    api/chat/route.ts      # streaming SSE proxy to the text model
    api/image/route.ts     # image proxy + free-tier cooldown handling
  components/
    Intro.tsx              # splash animation
    ChatPanel.tsx          # chat + markdown renderer (incl. tables)
    VoicePanel.tsx         # mic, waveform, speech recognition, TTS
    ImagePanel.tsx         # image studio + gallery
    VideoPanel.tsx         # keyframes → Ken Burns → MediaRecorder
    AgentPanel.tsx         # bridge UI + permission cards
    SettingsPanel.tsx      # memory, personas, data export
  lib/
    ai.ts                  # model layer (streamChat, chatOnce, imageUrl)
    db.ts                  # IndexedDB layer + message migration
    types.ts               # shared types + default personas
agent/
  bridge.mjs               # zero-dependency local desktop bridge
```

## Environment

No API keys required — the default provider is keyless. To swap in your own model, edit `src/lib/ai.ts` (and the two API routes if the wire format differs).

## Notes

- The free image tier allows roughly **one image every 45 seconds per IP**. Lumina tracks the cooldown server-side and shows an honest countdown instead of failing silently.
- Voice input requires **Chrome or Edge** (Web Speech API); playback works everywhere.
- Video export is **WebM** (VP9/VP8), which most modern players and editors accept.

## License

MIT
