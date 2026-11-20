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
    return await sharp(input).rotate().jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch (sharpErr) {
    try {
      return await viaImageMagick(input, kind);
    } catch (imErr) {
      console.warn(`[wish] ${kind} conversion failed: sharp: ${(sharpErr as Error).message.slice(0, 200)}; convert: ${(imErr as Error).message.slice(0, 300)}`);
      throw imErr;
    }
  }
}

/** The first bytes only say what a file claims to be: a truncated or
 *  corrupt file with a JPEG header would still be stored, queued and sent
 *  to a model. Decoding every pixel (`stats` reads them all) is what
 *  tells, and costs far less than a reading. */
async function assertDecodes(buf: Buffer): Promise<void> {
  try {
    const meta = await sharp(buf, { failOn: "error" }).metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    await sharp(buf, { failOn: "error" }).stats();
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
  let jpeg: Buffer;
  try {
    jpeg = await toJpeg(upload, heif);
  } catch {
    throw new ValidationProblem([
      { path: "file", code: "unreadable_image", message: `The ${heif.toUpperCase()} image could not be converted: save or share it as JPEG or PNG` },
    ]);
  }
  return { bytes: jpeg, mime: "image/jpeg", ext: "jpg", convertedFrom: heif };
}
