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
 *     (`setStoredImageHeaders`);
 *   - the bytes go out through `sendStoredFile`, which opens the file
 *     before anything is sent, so a file that cannot be opened is an
 *     error response and not a dead process.
 */
import type { Response } from "express";
import { open, realpath, stat, type FileHandle } from "fs/promises";
import * as path from "path";
import { pipeline } from "stream/promises";
import { NotFoundProblem } from "./problem.js";

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
 * The two headers that keep a stored file from running script: no type
 * sniffing, and a sandboxed, network-less document if a browser renders
 * it as one. `setStoredImageHeaders` sends them with the bytes; a route
 * that answers a conditional request with a 304 calls this first, so the
 * 304 carries them too.
 */
export function setStoredAssetGuards(res: Response): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", STORED_ASSET_CSP);
}

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
  setStoredAssetGuards(res);
  if (INLINE_IMAGE_TYPES.has(type)) {
    res.setHeader("Content-Type", type);
  } else {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment");
  }
}

/**
 * Generation of the headers `setStoredImageHeaders` sends. It is part of
 * the ETag on the two routes that revalidate (`/v1/brands/:id/icon`,
 * `/v1/products/:id/image`), for the reason `RENDER_VERSION` exists on
 * `/v1/documents/:id/rendered`: those routes answer `If-None-Match` with
 * a 304, and a browser keeps the headers it stored with the body. A copy
 * cached before the sandbox CSP existed would go on being served without
 * it for as long as the bytes did not change. Sending the CSP on the 304
 * as well is not enough on its own: browsers differ on which headers
 * they take from a 304 (Chromium applies a new CSP; WebKit's cache
 * update leaves `Content-*` headers alone). Changing the tag is what
 * makes every browser fetch the response again, once.
 *
 * Bump it whenever the security headers above change.
 *
 *   1 — the bare content hash; `Content-Type` only
 *   2 — nosniff + sandbox CSP; non-image types sent as a download
 */
const STORED_IMAGE_HEADERS_VERSION = 2;

/** Strong ETag for a stored image: its content hash plus the header
 *  generation it is served under. */
export function storedImageEtag(contentHash: string): string {
  return `"${contentHash}.h${STORED_IMAGE_HEADERS_VERSION}"`;
}

/**
 * Stream the file at `absPath` as the response body. Call it in place of
 * `createReadStream(absPath).pipe(res)`, after the headers are set, and
 * `await` it inside the handler's error wrapper.
 *
 * A bare `.pipe(res)` has no error listener. A file that passed
 * `resolveStoredFile` but cannot be opened — wrong permissions, or moved
 * to `.trash` between the check and the read — raises an unhandled
 * `'error'` event on the stream, and that ends the whole process, every
 * in-flight extraction with it.
 *
 * Here the file is opened first, while nothing has been sent, so that
 * failure is an ordinary rejection: 404 when the file has gone, otherwise
 * whatever `problemHandler` makes of it (which also drops the cache and
 * validator headers the caller staged for the success it expected).
 *
 * Once bytes are flowing the status line is out and there is no error
 * response left to give. `pipeline` tears the connection down, so the
 * client sees a truncated transfer rather than a complete-looking wrong
 * one, and closes the file whichever side stopped first.
 */
export async function sendStoredFile(
  res: Response,
  absPath: string,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(absPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundProblem("File");
    }
    throw err;
  }
  try {
    await pipeline(handle.createReadStream(), res);
  } catch (err) {
    // The client going away mid-download is not our error.
    if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
      return;
    }
    console.error(
      `[files] stream failed after the response had started: ${absPath}`,
      err,
    );
  }
}
