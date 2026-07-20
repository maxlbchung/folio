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

export const detectMediaPageType = (mimeType: string, filename = ""): MediaPageType | null => {
  const mime = mimeType.toLowerCase();
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const types = Object.keys(mediaExtensions) as MediaPageType[];
  return types.find((type) => mediaMimeTypes[type].has(mime))
    ?? types.find((type) => mediaExtensions[type].has(extension))
    ?? null;
};
