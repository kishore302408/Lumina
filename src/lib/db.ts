"use client";

import type {
  Conversation,
  GeneratedImage,
  GeneratedVideo,
  Memory,
  Message,
} from "./types";

const DB_NAME = "lumina-agent";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("conversations")) {
        const s = db.createObjectStore("conversations", { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const s = db.createObjectStore("messages", { keyPath: "id" });
        s.createIndex("conversationId", "conversationId");
        s.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("memories")) {
        db.createObjectStore("memories", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("videos")) {
        db.createObjectStore("videos", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const uid = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- conversations ---------- */

export async function putConversation(c: Conversation): Promise<void> {
  await tx("conversations", "readwrite", (s) => s.put(c) as IDBRequest<unknown>);
}

export async function listConversations(): Promise<Conversation[]> {
  const all = await tx<Conversation[]>("conversations", "readonly", (s) =>
    s.getAll() as IDBRequest<Conversation[]>,
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteConversation(id: string): Promise<void> {
  const msgs = await messagesFor(id);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(["conversations", "messages"], "readwrite");
    t.objectStore("conversations").delete(id);
    const store = t.objectStore("messages");
    for (const m of msgs) store.delete(m.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------- messages ---------- */

export async function putMessage(m: Message): Promise<void> {
  await tx("messages", "readwrite", (s) => s.put(m) as IDBRequest<unknown>);
}

/**
 * One-time repair for messages saved before `conversationId` existed:
 * adopt any orphaned message into the oldest conversation (or a new one).
 */
export async function migrateMessages(): Promise<void> {
  const all = await tx<Message[]>("messages", "readonly", (s) =>
    s.getAll() as IDBRequest<Message[]>,
  );
  const orphans = all.filter((m) => !m.conversationId);
  if (orphans.length === 0) return;

  const convs = await listConversations();
  const sorted = [...orphans].sort((a, b) => a.createdAt - b.createdAt);

  let target = convs.length
    ? [...convs].sort((a, b) => a.createdAt - b.createdAt)[0]
    : null;
  if (!target) {
    target = {
      id: uid(),
      title: sorted[0]?.content.slice(0, 42) || "Recovered chat",
      createdAt: sorted[0]?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await putConversation(target);
  }

  for (const m of sorted) {
    await putMessage({ ...m, conversationId: target.id });
  }
}

export async function messagesFor(conversationId: string): Promise<Message[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("messages", "readonly");
    const idx = t.objectStore("messages").index("conversationId");
    const req = idx.getAll(conversationId);
    req.onsuccess = () =>
      resolve(
        (req.result as Message[]).sort((a, b) => a.createdAt - b.createdAt),
      );
    req.onerror = () => reject(req.error);
  });
}

/* ---------- memories (persistent facts) ---------- */

export async function listMemories(): Promise<Memory[]> {
  const all = await tx<Memory[]>("memories", "readonly", (s) =>
    s.getAll() as IDBRequest<Memory[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putMemory(m: Memory): Promise<void> {
  await tx("memories", "readwrite", (s) => s.put(m) as IDBRequest<unknown>);
}

export async function deleteMemory(id: string): Promise<void> {
  await tx("memories", "readwrite", (s) => s.delete(id) as IDBRequest<unknown>);
}

/* ---------- media galleries ---------- */

export async function listImages(): Promise<GeneratedImage[]> {
  const all = await tx<GeneratedImage[]>("images", "readonly", (s) =>
    s.getAll() as IDBRequest<GeneratedImage[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putImage(i: GeneratedImage): Promise<void> {
  await tx("images", "readwrite", (s) => s.put(i) as IDBRequest<unknown>);
}

export async function deleteImage(id: string): Promise<void> {
  await tx("images", "readwrite", (s) => s.delete(id) as IDBRequest<unknown>);
}

export async function listVideos(): Promise<GeneratedVideo[]> {
  const all = await tx<GeneratedVideo[]>("videos", "readonly", (s) =>
    s.getAll() as IDBRequest<GeneratedVideo[]>,
  );
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putVideo(v: GeneratedVideo): Promise<void> {
  await tx("videos", "readwrite", (s) => s.put(v) as IDBRequest<unknown>);
}

export async function deleteVideo(id: string): Promise<void> {
  await tx("videos", "readwrite", (s) => s.delete(id) as IDBRequest<unknown>);
}

/* ---------- kv settings ---------- */

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await tx<{ key: string; value: T } | undefined>(
    "kv",
    "readonly",
    (s) => s.get(key) as IDBRequest<{ key: string; value: T } | undefined>,
  );
  return row?.value;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await tx("kv", "readwrite", (s) =>
    s.put({ key, value }) as IDBRequest<unknown>,
  );
}
