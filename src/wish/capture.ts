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
import { HttpProblem } from "../http/problem.js";
import { storableImage } from "./image.js";
import { matchPlaceByText, type PlaceMatch } from "./places.js";
import { convertWishesSafely } from "./loop.js";
import { buildWishReadPrompt, parseWishReading, type WishReading } from "./reading.js";

export const WISH_TITLE_WHILE_READING = "Reading…";
const READ_TIMEOUT_MS = 180_000;

export function wishImageRoot(): string {
  return path.join(getUploadDir(), "wish");
}

export interface CaptureInput {
  workspaceId: string;
  bytes: Buffer;
  /** What the person typed when saving, if anything. Stored as `notes`. */
  note: string | null;
}

export interface CaptureStarted {
  id: string;
  /** The same bytes were captured before: `id` is that wish, and nothing
   *  is read again. */
  existing: boolean;
}

async function wishWithImage(workspaceId: string, sourceSha: string): Promise<string | null> {
  const res = await db.execute(sql`
    SELECT id FROM wish_items WHERE workspace_id = ${workspaceId}::uuid AND image_source_sha256 = ${sourceSha}`);
  return (res.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** Store the image, insert the row, queue the reading. The same image
 *  uploaded again (same bytes) answers with the wish it already made. */
export async function startCapture(input: CaptureInput): Promise<CaptureStarted> {
  const sourceSha = createHash("sha256").update(input.bytes).digest("hex");
  const already = await wishWithImage(input.workspaceId, sourceSha);
  if (already) return { id: already, existing: true };

  const image = await storableImage(input.bytes);
  const sha = image.convertedFrom ? createHash("sha256").update(image.bytes).digest("hex") : sourceSha;
  const stored = `${sha}.${image.ext}`;
  const abs = resolveInside(wishImageRoot(), stored);
  if (!abs) throw new Error("wish image path left its root");
  await mkdir(wishImageRoot(), { recursive: true });
  try {
    await access(abs);
  } catch {
    await writeFile(abs, image.bytes, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }
  const id = randomUUID();
  const capture: Record<string, unknown> = { queued_at: new Date().toISOString() };
  if (image.convertedFrom) capture.converted_from = image.convertedFrom;
  // A place until the reading says otherwise: that is what most captures
  // are. Two uploads of one image at once: the unique index lets one in.
  const ins = await db.execute(sql`
    INSERT INTO wish_items (id, workspace_id, kind, title, notes, image_path, image_sha256, image_source_sha256, image_mime_type, capture_status, capture)
    VALUES (${id}::uuid, ${input.workspaceId}::uuid, 'place', ${WISH_TITLE_WHILE_READING}, ${input.note},
            ${stored}, ${sha}, ${sourceSha}, ${image.mime}, 'reading', ${JSON.stringify(capture)}::jsonb)
    ON CONFLICT (workspace_id, image_source_sha256) WHERE image_source_sha256 IS NOT NULL DO NOTHING
    RETURNING id`);
  if (ins.rows.length === 0) {
    const other = await wishWithImage(input.workspaceId, sourceSha);
    if (other) return { id: other, existing: true };
    throw new Error("wish capture insert conflicted with a row that is gone");
  }
  enqueue(id);
  return { id, existing: false };
}

/** Read a failed (or interrupted) capture again. */
export async function retryCapture(workspaceId: string, id: string): Promise<void> {
  const res = await db.execute(sql`
    UPDATE wish_items
       SET capture_status = 'reading',
           capture = jsonb_build_object('queued_at', now(), 'retry_of', capture)
                     || CASE WHEN capture ? 'converted_from' THEN jsonb_build_object('converted_from', capture->'converted_from') ELSE '{}'::jsonb END,
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

function placeQuery(r: WishReading): { query: string; basis: string } {
  const name = r.name_local && r.name_local !== r.title ? `${r.title} ${r.name_local}` : r.title;
  if (r.address) return { query: `${name} ${r.address}`, basis: "address" };
  if (r.locality) return { query: `${name} ${r.locality}`, basis: "locality" };
  return { query: name, basis: "name_only" };
}

function matchPlace(r: WishReading): Promise<PlaceMatch> {
  const { query, basis } = placeQuery(r);
  return matchPlaceByText(query, basis, r.name_local);
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

  const match = r.kind === "place" ? await matchPlace(r) : null;
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
           capture = ${JSON.stringify({ ...base, reading: r, place_match: match })}::jsonb
                     || CASE WHEN capture ? 'converted_from' THEN jsonb_build_object('converted_from', capture->'converted_from') ELSE '{}'::jsonb END,
           updated_at = now()
     WHERE id = ${id}::uuid AND capture_status = 'reading'`);
  // Been there already since the wish was made? Usually not.
  if (match?.place_id) await convertWishesSafely({ wishIds: [id] });
}
