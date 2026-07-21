export type MediaPageType = "image" | "video" | "audio";

/** The accepted media formats. The agent broker validates downloads against the
 * same sets, so anything that reaches asset registration also renders here. */
export const mediaExtensions: Record<MediaPageType, Set<string>> = {
  image: new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]),
  video: new Set(["m4v", "mov", "mp4", "ogv", "webm"]),
  audio: new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"])
};

export const mediaMimeTypes: Record<MediaPageType, Set<string>> = {
  image: new Set(["image/avif", "image/bmp", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"]),
  video: new Set(["video/mp4", "video/ogg", "video/quicktime", "video/webm"]),
  audio: new Set(["audio/aac", "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav"])
};

/** Best-effort MIME for files that arrive without type metadata (native OS drops read
 * from disk by path). Media elements need the Blob typed to render reliably. */
const extensionMimes: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", svg: "image/svg+xml", webp: "image/webp",
  m4v: "video/mp4", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg", webm: "video/webm",
  aac: "audio/aac", flac: "audio/flac", m4a: "audio/x-m4a", mp3: "audio/mpeg", ogg: "audio/ogg",
  opus: "audio/opus", wav: "audio/wav"
};

export const mimeForMediaFilename = (filename: string): string =>
  extensionMimes[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "";

export const detectMediaPageType = (mimeType: string, filename = ""): MediaPageType | null => {
  const mime = mimeType.toLowerCase();
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const types = Object.keys(mediaExtensions) as MediaPageType[];
  return types.find((type) => mediaMimeTypes[type].has(mime))
    ?? types.find((type) => mediaExtensions[type].has(extension))
    ?? null;
};
