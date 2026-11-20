/**
 * Wish capture: an image comes in, a wish row exists at once, and a
 * background step reads the image and fills the row.
 *
 *   POST /v1/wish-items/capture
 *     → the bytes are stored under <UPLOAD_DIR>/wish/<sha256>.<ext>
 *     → a row is inserted with capture_status = 'reading'  (202)
 *     → readCapture(): `claude -p` under the `image_read` profile hands
 *       back one reading (src/wish/reading.ts); the server validates it,
 *       looks the place up on Google with its own key, and writes the row
 *
 * "Agent reads, code writes", as for receipts: the agent has one tool
 * (Read), no shell, no network and no database. One capture is read at a
 * time, in arrival order; a server restart leaves a row 'reading', which
 * the next boot turns into 'failed' so it can be retried by hand.
 *
 * The images are not `documents`: a document is evidence for the ledger
 * (deduplicated, linked to transactions, swept by check-ledger), and a
 * screenshot of a restaurant post is none of that.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { runClaude } from "../claude.js";
import { getUploadDir } from "../routes/documents.service.js";
import { resolveInside } from "../http/files.js";
import { HttpProblem, ValidationProblem } from "../http/problem.js";
import { findPlaceByText, type FoundPlace } from "../google/find-place.js";
import { prefetchPlace, writePlace } from "../ingest/apply/places.js";
import { buildWishReadPrompt, parseWishReading, type WishReading } from "./reading.js";

export const WISH_TITLE_WHILE_READING = "Reading…";
const READ_TIMEOUT_MS = 180_000;

export function wishImageRoot(): string {
  return path.join(getUploadDir(), "wish");
}

/** The image types the Read tool shows a model, told apart by their bytes
 *  (a client's Content-Type is a claim, not a fact). */
function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return { mime: "image/gif", ext: "gif" };
  return null;
}

function isHeif(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(buf.toString("latin1", 8, 12));
}

export interface CaptureInput {
  workspaceId: string;
  bytes: Buffer;
  /** What the person typed when saving, if anything. Stored as `notes`. */
  note: string | null;
}

/** Store the image, insert the row, queue the reading. Returns the row id. */
export async function startCapture(input: CaptureInput): Promise<string> {
  const kind = sniffImage(input.bytes);
  if (!kind) {
    throw new ValidationProblem([
      {
        path: "file",
        code: "unsupported_image",
        message: isHeif(input.bytes)
          ? "HEIC / AVIF images cannot be read yet: save or share it as JPEG or PNG"
          : "The file is not a JPEG, PNG, WebP or GIF image",
      },
    ]);
  }
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const stored = `${sha}.${kind.ext}`;
  const abs = resolveInside(wishImageRoot(), stored);
  if (!abs) throw new Error("wish image path left its root");
  await mkdir(wishImageRoot(), { recursive: true });
  try {
    await access(abs);
  } catch {
    await writeFile(abs, input.bytes, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }
  const id = randomUUID();
  // A place until the reading says otherwise: that is what most captures are.
  await db.execute(sql`
    INSERT INTO wish_items (id, workspace_id, kind, title, notes, image_path, image_sha256, image_mime_type, capture_status, capture)
    VALUES (${id}::uuid, ${input.workspaceId}::uuid, 'place', ${WISH_TITLE_WHILE_READING}, ${input.note},
            ${stored}, ${sha}, ${kind.mime}, 'reading', ${JSON.stringify({ queued_at: new Date().toISOString() })}::jsonb)`);
  enqueue(id);
  return id;
}

/** Read a failed (or interrupted) capture again. */
export async function retryCapture(workspaceId: string, id: string): Promise<void> {
  const res = await db.execute(sql`
    UPDATE wish_items
       SET capture_status = 'reading',
           capture = jsonb_build_object('queued_at', now(), 'retry_of', capture),
           updated_at = now()
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
       AND image_path IS NOT NULL AND capture_status IN ('failed', 'done')
    RETURNING id`);
  if (res.rows.length === 0) {
    throw new HttpProblem(409, "capture-not-retryable", "Nothing to read again", "The wish has no captured image, or its image is being read now.");
  }
  enqueue(id);
}

// ── The queue: one reading at a time, in process ─────────────────────

let chain: Promise<void> = Promise.resolve();
function enqueue(id: string): void {
  chain = chain.then(() => readCapture(id)).catch((err) => console.error(`[wish] capture ${id} crashed:`, err));
}

/** For tests and scripts: resolves when every queued reading has ended. */
export function captureQueueIdle(): Promise<void> {
  return chain;
}

/** At boot nothing is being read: whatever says 'reading' was interrupted. */
export async function recoverInterruptedCaptures(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE wish_items
       SET capture_status = 'failed',
           capture = coalesce(capture, '{}'::jsonb) || jsonb_build_object('error', 'interrupted', 'detail', 'the server restarted while the image was being read'),
           updated_at = now()
     WHERE capture_status = 'reading'
    RETURNING id`);
  return res.rows.length;
}

// ── Reading one capture ──────────────────────────────────────────────

interface PlaceMatch {
  query: string;
  /** `address` | `locality` | `name_only`: what besides the name the query carried. */
  basis: string;
  google_place_id: string | null;
  name: string | null;
  formatted_address: string | null;
  place_id: string | null;
  error: string | null;
}

function placeQuery(r: WishReading): { query: string; basis: string } {
  const name = r.name_local && r.name_local !== r.title ? `${r.title} ${r.name_local}` : r.title;
  if (r.address) return { query: `${name} ${r.address}`, basis: "address" };
  if (r.locality) return { query: `${name} ${r.locality}`, basis: "locality" };
  return { query: name, basis: "name_only" };
}

async function matchPlace(r: WishReading): Promise<PlaceMatch> {
  const { query, basis } = placeQuery(r);
  const match: PlaceMatch = { query, basis, google_place_id: null, name: null, formatted_address: null, place_id: null, error: null };
  let found: FoundPlace | null;
  try {
    found = await findPlaceByText(query);
  } catch (err) {
    match.error = (err as Error).message;
    return match;
  }
  if (!found) {
    match.error = "no place found";
    return match;
  }
  match.google_place_id = found.googlePlaceId;
  match.name = found.name;
  match.formatted_address = found.formattedAddress;
  // A place the ledger already knows is linked as it is: `writePlace`
  // would count a visit (hit_count, last_seen_at), and wanting to go is
  // not having been.
  const known = await db.execute(sql`SELECT id FROM places WHERE google_place_id = ${found.googlePlaceId}`);
  if (known.rows.length > 0) {
    match.place_id = (known.rows[0] as { id: string }).id;
    return match;
  }
  const prefetch = await prefetchPlace(db, found.googlePlaceId);
  const written = await db.transaction((tx) => writePlace(tx, prefetch, r.name_local));
  match.place_id = written.placeId;
  if (!written.placeId) match.error = written.warnings[0]?.message ?? "the place could not be stored";
  return match;
}

async function failCapture(id: string, capture: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    UPDATE wish_items
       SET capture_status = 'failed',
           title = CASE WHEN title = ${WISH_TITLE_WHILE_READING} THEN 'Unread capture' ELSE title END,
           capture = ${JSON.stringify(capture)}::jsonb, updated_at = now()
     WHERE id = ${id}::uuid AND capture_status = 'reading'`);
}

async function readCapture(id: string): Promise<void> {
  const rows = await db.execute(sql`SELECT image_path, notes FROM wish_items WHERE id = ${id}::uuid AND capture_status = 'reading'`);
  const row = rows.rows[0] as { image_path: string | null; notes: string | null } | undefined;
  if (!row?.image_path) return; // deleted, or no longer waiting
  const abs = resolveInside(wishImageRoot(), row.image_path);
  if (!abs) return failCapture(id, { error: "image_missing" });

  const sessionId = randomUUID();
  const model = process.env.CLAUDE_MODEL || null;
  const base = { session_id: sessionId, model_requested: model, read_at: new Date().toISOString() };
  console.log(`[wish] read capture=${id} sessionId=${sessionId}`);
  let stdout: string;
  try {
    const args = ["--output-format", "text"];
    if (model) args.push("--model", model);
    ({ stdout } = await runClaude(buildWishReadPrompt(abs, row.notes), { profile: "image_read", args, timeoutMs: READ_TIMEOUT_MS, sessionId }));
  } catch (err) {
    console.error(`[wish] capture=${id} FAILED:`, (err as Error).message.slice(0, 300));
    return failCapture(id, { ...base, error: "agent_error", detail: (err as Error).message.slice(0, 300) });
  }
  const parsed = parseWishReading(stdout);
  if (!parsed.ok) return failCapture(id, { ...base, error: parsed.reason, detail: parsed.detail });
  const r = parsed.reading;
  if (r.kind === "none") {
    return failCapture(id, { ...base, error: "nothing_to_save", detail: r.title, reading: r });
  }

  const match = r.kind === "place" ? await matchPlace(r).catch((err): PlaceMatch => ({
    ...placeQuery(r), google_place_id: null, name: null, formatted_address: null, place_id: null, error: (err as Error).message.slice(0, 200),
  })) : null;
  if (match?.error) console.warn(`[wish] capture=${id} place not linked: ${match.error}`);

  // Only a row still waiting is written: one deleted or edited into
  // another state while the image was read is left as the person left it.
  await db.execute(sql`
    UPDATE wish_items
       SET kind = ${r.kind},
           title = ${r.title},
           notes = coalesce(notes, ${r.note}),
           source_url = coalesce(source_url, ${r.source_url}),
           target_price_minor = CASE WHEN ${r.kind} = 'thing' THEN coalesce(target_price_minor, ${r.price_minor}::int) ELSE target_price_minor END,
           currency = CASE WHEN ${r.kind} = 'thing' AND ${r.currency}::text IS NOT NULL THEN ${r.currency} ELSE currency END,
           place_id = ${match?.place_id ?? null}::uuid,
           capture_status = 'done',
           capture = ${JSON.stringify({ ...base, reading: r, place_match: match })}::jsonb,
           updated_at = now()
     WHERE id = ${id}::uuid AND capture_status = 'reading'`);
}
