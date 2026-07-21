// Machine-local resume state for Inkjet: document id → CLI session id per
// backend, in one small JSON file under the app's data dir. The conversations
// themselves live in each CLI's own on-disk history, so a remembered id is all
// it takes to pick a conversation back up in a later app run — this file is
// what carries those ids across broker processes. It also owns the stable
// working directories for the CLIs that key their history by cwd (claude,
// opencode), so a remembered id still resolves no matter where the app was
// launched from.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Mirrors Tauri's app-data location for the app identifier, so everything
 * Inktile keeps on this machine lives under one folder. */
const appDataRoot = () => {
  const home = homedir();
  if (process.platform === "win32") return process.env.APPDATA || join(home, "AppData", "Roaming");
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  return process.env.XDG_DATA_HOME || join(home, ".local", "share");
};

const agentDataDir = join(appDataRoot(), "com.inktile.editor", "agent");
const storePath = join(agentDataDir, "sessions.json");

/** A stable directory under the agent data dir, created on demand. Used as the
 * cwd for CLIs whose session history is keyed by working directory. */
export const stableDir = (name) => {
  const dir = join(agentDataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Cross-run growth guard: resume ids for documents untouched the longest are
 * dropped once the store tracks more documents than this. */
const MAX_DOCS = 100;

/** @type {Record<string, { updatedAt: number, backends: Record<string, string> }>} */
const state = (() => {
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing or corrupt store: resume state starts empty.
  }
  return {};
})();

const persist = () => {
  const docIds = Object.keys(state);
  if (docIds.length > MAX_DOCS) {
    docIds
      .sort((a, b) => (state[b].updatedAt ?? 0) - (state[a].updatedAt ?? 0))
      .slice(MAX_DOCS)
      .forEach((docId) => delete state[docId]);
  }
  try {
    mkdirSync(agentDataDir, { recursive: true });
    writeFileSync(storePath, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort: resume still works within this run. The store is loaded
    // once per broker, so concurrent app instances are last-writer-wins — at
    // worst a resume id is forgotten and the next turn starts fresh.
  }
};

/** One backend's column of the store, Map-shaped so the backends keep their
 * `sessions.get/set/delete/has` call sites unchanged while every write lands
 * on disk. `set` is a no-op when the id is unchanged (opencode re-reports the
 * session id on every stream event). */
export const createSessionMap = (backend) => ({
  has: (docKey) => Boolean(state[docKey]?.backends?.[backend]),
  get: (docKey) => state[docKey]?.backends?.[backend],
  set: (docKey, sessionId) => {
    const entry = state[docKey] ?? (state[docKey] = { updatedAt: 0, backends: {} });
    if (entry.backends[backend] === sessionId) return;
    entry.backends[backend] = sessionId;
    entry.updatedAt = Date.now();
    persist();
  },
  delete: (docKey) => {
    const entry = state[docKey];
    if (!entry?.backends?.[backend]) return;
    delete entry.backends[backend];
    if (Object.keys(entry.backends).length === 0) delete state[docKey];
    persist();
  }
});
