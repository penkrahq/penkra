// Presented files from older builds have application/octet-stream metadata.
// Known video extensions identify their media type without rewriting saved items.
const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

export function presentedVideoMimeType(item: { name: string; mimeType: string }): string | null {
  const mimeType = item.mimeType.trim().toLowerCase();
  if (mimeType.startsWith("video/")) return mimeType;
  if (mimeType !== "application/octet-stream") return null;
  return VIDEO_MIME_BY_EXTENSION[item.name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}
