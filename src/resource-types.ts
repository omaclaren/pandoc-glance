import { extname } from "node:path";

/** Browser-renderable local media types exposed by the watch server. */
const PREVIEW_RESOURCE_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".pdf", "application/pdf"],
]);

export function previewResourceContentType(filePath: string): string | undefined {
  return PREVIEW_RESOURCE_MIME_TYPES.get(extname(filePath).toLowerCase());
}
