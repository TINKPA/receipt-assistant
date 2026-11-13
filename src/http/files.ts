/**
 * Serving a file whose location and type are database values.
 *
 * `brand_assets.local_path`, `product_assets.local_path`,
 * `place_photos.file_path` and their `content_type` / `mime_type`
 * columns are written by the extraction agent through `psql`, and the
 * bytes behind them were fetched from arbitrary websites. Neither the
 * path nor the type can be taken at its word:
 *
 *   - a path is served only if it resolves — symlinks followed — to a
 *     regular file inside the directory that kind of asset lives in
 *     (`resolveStoredFile`). Rows that hold an absolute path keep
 *     working as long as it points inside that directory;
 *   - a type is sent only if it is one of a handful of image types;
 *     anything else goes out as an opaque download. And every response
 *     carries `nosniff` plus a CSP with `sandbox`, so an SVG opened
 *     directly at its URL — where, unlike in an `<img>`, it is a
 *     document on the app's origin — cannot run script
 *     (`setStoredImageHeaders`).
 */
import type { Response } from "express";
import { realpath, stat } from "fs/promises";
import * as path from "path";

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Resolve `stored` (relative to `root`, or absolute) and return the
 * absolute path only if it lies inside `root`. Purely lexical — use it
 * before WRITING, where the file does not exist yet. Reads go through
 * `resolveStoredFile`, which also follows symlinks.
 */
export function resolveInside(root: string, stored: string): string | null {
  if (stored === "" || stored.includes("\0")) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, stored);
  return isInside(rootAbs, abs) ? abs : null;
}

/**
 * The absolute path of an existing regular file that `stored` names
 * inside `root`, or `null` — when the row has no path, the path leaves
 * `root` (lexically, or through a symlink), or nothing is on disk.
 *
 * Callers answer 404 for `null` without saying which: whether a file
 * exists outside the root is itself something not to disclose.
 */
export async function resolveStoredFile(
  root: string,
  stored: string | null | undefined,
): Promise<string | null> {
  if (!stored) return null;
  const abs = resolveInside(root, stored);
  if (!abs) {
    console.warn(
      `[files] refusing a stored path outside its root: root=${root} stored=${JSON.stringify(stored)}`,
    );
    return null;
  }
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(abs)]);
    if (!isInside(realRoot, realFile)) {
      console.warn(
        `[files] refusing a stored path that leaves its root through a symlink: root=${root} stored=${JSON.stringify(stored)}`,
      );
      return null;
    }
    return (await stat(realFile)).isFile() ? realFile : null;
  } catch {
    return null; // not on disk
  }
}

/** Types a browser may render inline from an asset endpoint. */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/**
 * `default-src 'none'` + `sandbox`: a document loaded from this response
 * gets an opaque origin and no script, no plugins, no network. Inline
 * style and `data:` images stay allowed so an SVG still draws when
 * opened on its own. An `<img>` ignores the header entirely, which is
 * why icons keep rendering.
 */
const STORED_ASSET_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/**
 * Set the content headers for a stored image. Call it in place of
 * `res.setHeader("Content-Type", row.contentType)`.
 */
export function setStoredImageHeaders(
  res: Response,
  storedType: string | null | undefined,
): void {
  const base = (storedType ?? "").split(";")[0]!.trim().toLowerCase();
  const type = base === "image/jpg" ? "image/jpeg" : base;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", STORED_ASSET_CSP);
  if (INLINE_IMAGE_TYPES.has(type)) {
    res.setHeader("Content-Type", type);
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment");
  }
}
