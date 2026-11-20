/**
 * What a wish capture stores: a JPEG, PNG, WebP or GIF, the types the
 * Read tool shows a model. An iPhone photo or screenshot shared as HEIC
 * (or an AVIF) is converted to JPEG first, so the stored file, the image
 * endpoint and the reading all see the same JPEG.
 *
 * Conversion: sharp first (its prebuilt libvips decodes AVIF but not
 * HEVC-coded HEIC), then ImageMagick's `convert`, which the runtime image
 * has with the HEIC and AVIF coders. Both auto-orient and drop the
 * metadata, so a photo's GPS position is not kept.
 */
import { spawn } from "node:child_process";
import sharp from "sharp";
import { ValidationProblem } from "../http/problem.js";

export interface StoredImage {
  bytes: Buffer;
  mime: string;
  ext: string;
  /** `heic` | `avif` when the upload was converted, else null. */
  convertedFrom: "heic" | "avif" | null;
}

/** The image types the Read tool shows a model, told apart by their bytes
 *  (a client's Content-Type is a claim, not a fact). */
export function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return { mime: "image/gif", ext: "gif" };
  return null;
}

/** An ISO-BMFF image (HEIF family) by its `ftyp` major brand. */
export function heifKind(buf: Buffer): "heic" | "avif" | null {
  if (buf.length < 12 || buf.toString("latin1", 4, 8) !== "ftyp") return null;
  const brand = buf.toString("latin1", 8, 12);
  if (brand === "avif" || brand === "avis") return "avif";
  if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return "heic";
  return null;
}

const JPEG_QUALITY = 88;
const CONVERT_TIMEOUT_MS = 60_000;

function viaImageMagick(input: Buffer, coder: "heic" | "avif"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("convert", [`${coder}:-`, "-auto-orient", "-strip", "-quality", String(JPEG_QUALITY), "jpeg:-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CONVERT_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      if (err.length < 2000) err += c.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0 && sniffImage(buf)?.mime === "image/jpeg") resolve(buf);
      else reject(new Error(`convert exited ${code ?? signal}: ${err.trim().slice(0, 300)}`));
    });
    // The child can exit before it drains stdin (a bad coder): never crash on EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function toJpeg(input: Buffer, kind: "heic" | "avif"): Promise<Buffer> {
  try {
    return await sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS }).rotate().jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch (sharpErr) {
    try {
      return await viaImageMagick(input, kind);
    } catch (imErr) {
      console.warn(`[wish] ${kind} conversion failed: sharp: ${(sharpErr as Error).message.slice(0, 200)}; convert: ${(imErr as Error).message.slice(0, 300)}`);
      throw imErr;
    }
  }
}

/** More pixels than any photo or screenshot worth reading (a phone
 *  screenshot is about 3.5M, a 48 MP photo 48M). Checked from the header
 *  before any pixel is decoded, for every type (HEIC and AVIF by
 *  `heifDimensions`, before the conversion): a small file can declare
 *  15000×15000, and decoding it costs seconds and hundreds of MB. */
export const MAX_IMAGE_PIXELS = 50_000_000;

function tooLarge(width: number, height: number): ValidationProblem {
  console.warn(`[wish] upload refused: ${width}x${height} is over ${MAX_IMAGE_PIXELS} pixels`);
  return new ValidationProblem([
    {
      path: "file",
      code: "image_too_large",
      message: `The image is ${width}×${height}; send one under ${MAX_IMAGE_PIXELS / 1_000_000} million pixels`,
    },
  ]);
}

/**
 * A HEIC or AVIF image's size from its header: the `ispe` (image spatial
 * extents) properties of its items, the largest one (a HEIC photo is a
 * grid of 512×512 tiles, each with its own `ispe`, plus the grid's). Read
 * from the bytes, before anything decodes them: sharp and ImageMagick
 * both decode the whole image to convert it, which for a 38 KB file that
 * declares 8000×8000 costs about 800 MB. Null when there is none.
 */
export function heifDimensions(buf: Buffer): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  for (let i = buf.indexOf("ispe", 4, "latin1"); i >= 4; i = buf.indexOf("ispe", i + 4, "latin1")) {
    // A box: size (4 bytes, 20 for ispe), type, version and flags, width, height.
    if (i + 16 > buf.length || buf.readUInt32BE(i - 4) !== 20) continue;
    const width = buf.readUInt32BE(i + 8);
    const height = buf.readUInt32BE(i + 12);
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/** The first bytes only say what a file claims to be: a truncated or
 *  corrupt file with a JPEG header would still be stored, queued and sent
 *  to a model. Decoding every pixel (`stats` reads them all) is what
 *  tells, and costs far less than a reading. */
async function assertDecodes(buf: Buffer): Promise<void> {
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf, { failOn: "error" }).metadata();
  } catch (err) {
    console.warn(`[wish] upload does not decode: ${(err as Error).message.slice(0, 200)}`);
    throw new ValidationProblem([
      { path: "file", code: "unreadable_image", message: "The file could not be decoded as an image: it may be truncated or damaged" },
    ]);
  }
  // One frame: that is all `stats` decodes, and all the Read tool shows.
  if (meta.width && meta.height && meta.width * meta.height > MAX_IMAGE_PIXELS) throw tooLarge(meta.width, meta.height);
  try {
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    await sharp(buf, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).stats();
  } catch (err) {
    console.warn(`[wish] upload does not decode: ${(err as Error).message.slice(0, 200)}`);
    throw new ValidationProblem([
      { path: "file", code: "unreadable_image", message: "The file could not be decoded as an image: it may be truncated or damaged" },
    ]);
  }
}

/** The bytes to store for an upload, or a 422 for anything else. */
export async function storableImage(upload: Buffer): Promise<StoredImage> {
  const kind = sniffImage(upload);
  if (kind) {
    await assertDecodes(upload);
    return { bytes: upload, ...kind, convertedFrom: null };
  }
  const heif = heifKind(upload);
  if (!heif) {
    throw new ValidationProblem([
      { path: "file", code: "unsupported_image", message: "The file is not a JPEG, PNG, WebP, GIF, HEIC or AVIF image" },
    ]);
  }
  // Its size from the header first: converting decodes every pixel.
  const dims = heifDimensions(upload) ?? (await sharp(upload).metadata().then((m) => (m.width && m.height ? { width: m.width, height: m.height } : null), () => null));
  if (!dims) {
    throw new ValidationProblem([
      { path: "file", code: "unreadable_image", message: `The ${heif.toUpperCase()} image has no size in its header: save or share it as JPEG or PNG` },
    ]);
  }
  if (dims.width * dims.height > MAX_IMAGE_PIXELS) throw tooLarge(dims.width, dims.height);
  let jpeg: Buffer;
  try {
    jpeg = await toJpeg(upload, heif);
  } catch {
    throw new ValidationProblem([
      { path: "file", code: "unreadable_image", message: `The ${heif.toUpperCase()} image could not be converted: save or share it as JPEG or PNG` },
    ]);
  }
  // The converted file is held to the same limit (its pixels are what a
  // reading would see).
  await assertDecodes(jpeg);
  return { bytes: jpeg, mime: "image/jpeg", ext: "jpg", convertedFrom: heif };
}
