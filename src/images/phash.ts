/**
 * 64-bit DCT perceptual hash for receipt images (#134, L2 dedup evidence).
 *
 * Algorithm mirrors python `imagehash.phash` (the implementation the
 * 2026-06-10 threshold calibration ran on): greyscale → 32×32 resize →
 * 2D DCT-II → top-left 8×8 low-frequency block → bit = coefficient >
 * median. Exact hash values differ from the python implementation by a
 * few bits (resampling filters differ), but pairwise hamming distances
 * are stable as long as BOTH sides of a comparison use THIS
 * implementation — which is the only comparison the backend ever does.
 * Re-derive thresholds with `scripts/backfill-phash.ts --calibrate`
 * after any change here.
 *
 * Calibration result (189-image production corpus): true duplicates
 * (re-shots / re-captured screenshots) at d ≤ 2, d=4 empty, false
 * positives (same composition, different receipt) from d = 6. Treat
 * d ≤ 4 as strong evidence; never auto-merge on pHash alone.
 */
import sharp from "sharp";

const SIZE = 32; // resize edge
const LOW = 8; // low-frequency block edge → 64 bits

/** Precomputed DCT-II cosine table: COS[k][n] = cos(π/N · (n + ½) · k). */
const COS: number[][] = Array.from({ length: SIZE }, (_, k) =>
  Array.from({ length: SIZE }, (_, n) =>
    Math.cos((Math.PI / SIZE) * (n + 0.5) * k),
  ),
);

function dct2d(pixels: Float64Array): Float64Array {
  // rows then columns; unnormalized DCT-II (normalization cancels in
  // the median comparison).
  const tmp = new Float64Array(SIZE * SIZE);
  const out = new Float64Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) {
    for (let k = 0; k < SIZE; k++) {
      let s = 0;
      for (let n = 0; n < SIZE; n++) s += pixels[r * SIZE + n]! * COS[k]![n]!;
      tmp[r * SIZE + k] = s;
    }
  }
  for (let c = 0; c < SIZE; c++) {
    for (let k = 0; k < SIZE; k++) {
      let s = 0;
      for (let n = 0; n < SIZE; n++) s += tmp[n * SIZE + c]! * COS[k]![n]!;
      out[k * SIZE + c] = s;
    }
  }
  return out;
}

/**
 * Compute the 16-hex-char pHash of an image buffer, or null when the
 * buffer cannot be decoded (corrupt file, unsupported codec). Never
 * throws — a missing hash only weakens dedup evidence, it must not
 * fail an upload.
 */
export async function computePhash(bytes: Buffer): Promise<string | null> {
  try {
    const raw = await sharp(bytes, { failOn: "truncated" })
      .rotate() // honor EXIF orientation so re-shots align
      .greyscale()
      .resize(SIZE, SIZE, { fit: "fill" })
      .raw()
      .toBuffer();
    const pixels = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) pixels[i] = raw[i]!;

    const dct = dct2d(pixels);
    const low: number[] = [];
    for (let r = 0; r < LOW; r++)
      for (let c = 0; c < LOW; c++) low.push(dct[r * SIZE + c]!);

    const sorted = [...low].sort((a, b) => a - b);
    const median = (sorted[31]! + sorted[32]!) / 2;

    let hex = "";
    for (let nibble = 0; nibble < 16; nibble++) {
      let v = 0;
      for (let b = 0; b < 4; b++) {
        v = (v << 1) | (low[nibble * 4 + b]! > median ? 1 : 0);
      }
      hex += v.toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

/** Hamming distance between two 16-hex-char pHashes (0–64). */
export function phashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Mime types we attempt to hash. */
export function isHashableImageMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().split(";")[0]!.trim();
  return (
    m.startsWith("image/") && m !== "image/heic" && m !== "image/heif"
    // sharp decodes heic only when built with libheif; skip rather
    // than risk a hard dependency. HEIC re-shots fall through to the
    // L3a field check.
  );
}
