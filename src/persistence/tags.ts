import { uuid } from "../document/factories";
import { getStorage } from "./storage";
import type { InktileTag } from "./storage/types";
import { removeTagFromAllLibraryInktiles } from "./library";

export type { InktileTag } from "./storage/types";

/** Preset dot colors, mirroring the editor's hue palette. Hues render identically in both
    themes (same contract as the text-color swatches), so no light/dark mapping is needed. */
export const TAG_COLORS = [
  "#c0392b",
  "#e2711d",
  "#d4a017",
  "#27ae60",
  "#16a085",
  "#2f80cf",
  "#8e44ad",
  "#d81b60",
  "#8d6e63",
  "#6d7178"
];

const tagsCache = new Map<string, InktileTag>();
let tagsLoaded = false;
let tagsLoad: Promise<void> | null = null;

const byName = (left: InktileTag, right: InktileTag): number =>
  left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });

export async function listTags(): Promise<InktileTag[]> {
  if (!tagsLoaded) {
    tagsLoad ??= (async () => {
      const storage = await getStorage();
      (await storage.listTags()).forEach((tag) => tagsCache.set(tag.id, tag));
      tagsLoaded = true;
    })().finally(() => { tagsLoad = null; });
    await tagsLoad;
  }
  return [...tagsCache.values()].sort(byName);
}

export async function createTag(name: string, color: string): Promise<InktileTag> {
  const tag: InktileTag = {
    id: uuid(),
    name: name.trim() || "Untitled tag",
    color,
    createdAt: new Date().toISOString()
  };
  const storage = await getStorage();
  await storage.putTag(tag);
  tagsCache.set(tag.id, tag);
  return tag;
}

export async function updateTag(id: string, patch: Partial<Pick<InktileTag, "name" | "color">>): Promise<InktileTag | null> {
  const storage = await getStorage();
  const record = await storage.getTag(id);
  if (!record) return null;
  const next: InktileTag = {
    ...record,
    ...patch,
    name: (patch.name ?? record.name).trim() || record.name
  };
  await storage.putTag(next);
  tagsCache.set(id, next);
  return next;
}

/** Delete a tag definition and strip its id from every inktile that carries it. */
export async function deleteTag(id: string): Promise<void> {
  tagsCache.delete(id);
  const storage = await getStorage();
  await storage.deleteTag(id);
  await removeTagFromAllLibraryInktiles(id);
}
