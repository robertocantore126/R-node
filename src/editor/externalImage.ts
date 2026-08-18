/**
 * External image drag-drop sources (T-extension): an image dragged from the
 * OS file explorer or from a browser page lands on the canvas as one of two
 * shapes — a `File` in `dataTransfer.files`, or, when the browser only hands
 * over the image URL (common for cross-origin images), a `text/uri-list`
 * string. This module turns either into a `File` the import pipeline already
 * knows how to handle (`attachImageFile`).
 *
 * The fetch of a dropped URL runs through `tauri-plugin-http` inside the
 * desktop webview (CORS-free, Rust-side) and through plain `window.fetch`
 * in the web build, where the page's own origin rules apply.
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type FetchFn = (url: string) => Promise<Response>;

/** The fetch implementation for the current runtime (Tauri webview vs browser). */
export function resolveFetcher(): FetchFn {
  const tauri = typeof window !== "undefined" && !!window.__TAURI__;
  return tauri ? tauriFetch : window.fetch.bind(window);
}

/** Every `image/*` entry in the dropped file list, in order. */
export function imageFiles(files: FileList | File[]): File[] {
  const out: File[] = [];
  for (const f of files) {
    if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/** First `image/*` entry in the dropped file list, or null. */
export function firstImageFile(files: FileList | File[]): File | null {
  return imageFiles(files)[0] ?? null;
}

/**
 * First URL in a `text/uri-list` payload. Comment lines start with `#`;
 * the browser also appends the URL of the page the image came from on a
 * later line — the FIRST non-comment line is the image itself.
 */
export function firstUriFromList(uriList: string): string | null {
  for (const line of uriList.split("\n")) {
    const url = line.trim();
    if (url && !url.startsWith("#")) return url;
  }
  return null;
}

/** A dropped URL that is definitely an image (so the URL→bytes direction is a
 *  download, never a re-upload of local data). */
const URL_BYTE_CAP = 25 * 1024 * 1024; // same ceiling as MAX_SOURCE_BYTES

/**
 * Download the image at `url` as a `File`, or null when the response is not
 * an image / too large / unreachable. `fetcher` is injectable for tests.
 */
export async function fetchImageAsFile(
  url: string,
  fetcher: FetchFn = resolveFetcher()
): Promise<File | null> {
  let res: Response;
  try {
    res = await fetcher(url);
  } catch {
    return null; // network error / CORS / plugin unvailable
  }
  if (!res.ok) return null;
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > URL_BYTE_CAP) return null;
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return null;
  }
  if (!blob.type.startsWith("image/")) return null;
  if (blob.size > URL_BYTE_CAP) return null;
  const name = url.split("/").pop()?.split("?")[0] || "dropped-image";
  return new File([blob], name, { type: blob.type });
}
