export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: string;
  content: string;
  createdAt: number;
}

export interface GeneratedImage {
  id: string;
  prompt: string;
  url: string;
  seed: number;
  width: number;
  height: number;
  createdAt: number;
}

export interface GeneratedVideo {
  id: string;
  prompt: string;
  url: string;
  frames: number;
  durationSec: number;
  createdAt: number;
}

export interface Persona {
  id: string;
  name: string;
  system: string;
}

export type PanelId =
  | "chat"
  | "voice"
  | "image"
  | "video"
  | "agent"
  | "settings";

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: "lumino",
    name: "Lumino",
    system:
      "You are Lumino Agent, a warm, sharp and highly capable AI companion created for Kishore. " +
      "You are curious, lightly playful, and never sycophantic. Be concise by default, but expand when the task deserves it. " +
      "Use Markdown when it improves readability (lists, code blocks, tables). " +
      "You can chat, guide voice conversations, help craft image/video prompts, and assist with local desktop tasks when the local agent bridge is connected. " +
      "Always be honest about what you cannot do.",
  },
  {
    id: "engineer",
    name: "Engineer",
    system:
      "You are Lumino Agent in Engineer mode: a senior software engineer. Lead with the solution, include working code, " +
      "call out edge cases and trade-offs, and never invent APIs. Ask clarifying questions only when they block progress.",
  },
  {
    id: "creative",
    name: "Creative",
    system:
      "You are Lumino Agent in Creative mode: an imaginative director and storyteller. Be vivid, surprising and visual. " +
      "Great at naming, worldbuilding, script writing, and rich prompts for image and video generation.",
  },
];
