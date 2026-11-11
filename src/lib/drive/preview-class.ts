export const PREVIEW_CLASSES = ["image", "pdf", "text", "video", "note", "other"] as const;

export type PreviewClass = (typeof PREVIEW_CLASSES)[number];

export function previewClassFor(mediaType: string, name = ""): PreviewClass {
  const type = mediaType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("video/")) return "video";
  if (name.endsWith(".note")) return "note";
  if (type === "text/plain" || type === "text/csv" || type === "application/json") return "text";
  return "other";
}

export function isPreviewClass(value: string): value is PreviewClass {
  return (PREVIEW_CLASSES as readonly string[]).includes(value);
}

/** Client-side name search. Sealed names are matched only after they are opened locally. */
export function nameMatches(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().includes(needle);
}
