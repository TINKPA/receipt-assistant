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
import { isLandmarkAddress, matchPlaceByText, workspaceArea, type PlaceMatch } from "./places.js";
import { settleWishesSafely } from "./loop.js";
import {
  WISH_READ_PROMPT_VERSION,
  buildWishReadPrompt,
  parseWishReading,
  type WishReading,
  type WishReadingOther,
} from "./reading.js";

export const WISH_TITLE_WHILE_READING = "Reading…";
/** The title of a capture that could not be read (nothing came back). */
export const WISH_TITLE_UNREAD = "Unread capture";
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
   *  is read again. A note sent with them is added to its notes. */
  existing: boolean;
}

/** A note sent with an image already captured: kept, not dropped. It
 *  becomes the notes when there are none, and is appended otherwise
 *  (unless those notes already say it). */
async function addNote(id: string, note: string): Promise<void> {
  await db.execute(sql`
    UPDATE wish_items
       SET notes = CASE
                     WHEN notes IS NULL OR btrim(notes) = '' THEN ${note}
                     WHEN position(${note} in notes) > 0 THEN notes
                     ELSE left(notes || E'\n\n' || ${note}, 5000)
                   END,
           updated_at = now()
     WHERE id = ${id}::uuid`);
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
  if (already) {
    if (input.note) await addNote(already, input.note);
    return { id: already, existing: true };
  }

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
    if (other) {
      if (input.note) await addNote(other, input.note);
      return { id: other, existing: true };
    }
    throw new Error("wish capture insert conflicted with a row that is gone");
  }
  enqueue(id);
  return { id, existing: false };
}

/** `capture` keys that outlive a reading: what the upload was converted
 *  from, which fields the person set by hand (a new reading leaves those
 *  alone), the wish it was split from and the ones split from it. */
const KEPT_CAPTURE_KEYS = ["converted_from", "user_set", "sibling_of", "siblings"] as const;
const keepCaptureKeys = sql.raw(
  KEPT_CAPTURE_KEYS.map(
    (k) => `CASE WHEN capture ? '${k}' THEN jsonb_build_object('${k}', capture->'${k}') ELSE '{}'::jsonb END`,
  ).join(" || "),
);

/** The wish a sibling was split from still exists. */
const originalExists = sql`EXISTS (SELECT 1 FROM wish_items o
                                    WHERE o.id::text = wish_items.capture->>'sibling_of' AND o.workspace_id = wish_items.workspace_id)`;

/** Read a failed (or interrupted) capture again. Fields the person set by
 *  hand stay theirs (`capture.user_set`). A wish split from another
 *  capture is read through that one, which reads all the places in the
 *  image; once that wish is deleted, the split one is read on its own,
 *  for its own entry of the list (`readCapture`). */
export async function retryCapture(workspaceId: string, id: string): Promise<void> {
  const res = await db.execute(sql`
    UPDATE wish_items
       SET capture_status = 'reading',
           capture = jsonb_build_object('queued_at', now(), 'retry_of', capture) || ${keepCaptureKeys},
           updated_at = now()
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
       AND image_path IS NOT NULL AND capture_status IN ('failed', 'done')
       AND NOT (coalesce(capture ? 'sibling_of', false) AND ${originalExists})
    RETURNING id`);
  if (res.rows.length === 0) {
    const why = await db.execute(sql`
      SELECT capture->>'sibling_of' AS sibling_of FROM wish_items
       WHERE id = ${id}::uuid AND coalesce(capture ? 'sibling_of', false) AND ${originalExists}`);
    const siblingOf = (why.rows[0] as { sibling_of: string | null } | undefined)?.sibling_of;
    if (siblingOf) {
      throw new HttpProblem(
        409,
        "capture-not-retryable",
        "Read the original capture instead",
        `This wish is one of several places in an image captured as wish ${siblingOf}; reading that image again reads all of them.`,
      );
    }
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

interface Placeable {
  title: string;
  name_local: string | null;
  locality: string | null;
  address: string | null;
}

function placeQuery(r: Placeable): { query: string; basis: "address" | "locality" | "name_only" } {
  const name = r.name_local && r.name_local !== r.title ? `${r.title} ${r.name_local}` : r.title;
  // The address with its neighbourhood or city: "7 Carmine St" alone is a
  // street in many towns.
  // A landmark ("near X St") with no city says too little to rest on.
  if (r.address && isLandmarkAddress(r.address) && !r.locality) return { query: `${name} ${r.address}`, basis: "name_only" };
  if (r.address) return { query: [name, r.address, r.locality].filter(Boolean).join(" "), basis: "address" };
  if (r.locality) return { query: `${name} ${r.locality}`, basis: "locality" };
  return { query: name, basis: "name_only" };
}

/** A capture's place. A name with no city or address, or a reading the
 *  model was not sure of, is only a suggestion (src/wish/places.ts): the
 *  image is about someone else's town as often as the person's own. */
async function matchPlace(workspaceId: string, r: Placeable, confidence: WishReading["confidence"]): Promise<PlaceMatch> {
  const { query, basis } = placeQuery(r);
  const guessReason = basis === "name_only" ? "name_only" : confidence === "low" ? "low_confidence" : null;
  const names = [r.title, r.name_local].filter((n): n is string => Boolean(n));
  return matchPlaceByText(query, basis, r.name_local, {
    names,
    guessReason,
    // An address or a city is what the match rests on; a Han name and
    // Google's English one cannot be compared word by word.
    trustUncomparable: basis !== "name_only",
    address: r.address,
    locality: r.locality,
    // With no city in the image, the person's own area is the best guess.
    locationBias: basis === "name_only" ? await workspaceArea(workspaceId) : null,
  });
}

interface UserSet {
  title?: boolean;
  kind?: boolean;
  place?: boolean;
}

function userSetOf(capture: unknown): UserSet {
  const u = (capture as { user_set?: unknown } | null)?.user_set;
  return u && typeof u === "object" ? (u as UserSet) : {};
}

async function failCapture(id: string, capture: Record<string, unknown>, describedAs: string | null = null): Promise<void> {
  // A wish the person already named or placed by hand is theirs: the
  // failure is kept as history and the wish stays resolved.
  await db.execute(sql`
    UPDATE wish_items
       SET capture_status = CASE WHEN coalesce(capture->'user_set', '{}'::jsonb) <> '{}'::jsonb THEN 'done' ELSE 'failed' END,
           title = CASE WHEN title IN (${WISH_TITLE_WHILE_READING}, ${WISH_TITLE_UNREAD}) AND NOT coalesce(capture->'user_set' ? 'title', false)
                        THEN coalesce(${describedAs}::text, ${WISH_TITLE_UNREAD}) ELSE title END,
           capture = ${JSON.stringify({ ...capture, prompt_version: WISH_READ_PROMPT_VERSION })}::jsonb
                     || ${keepCaptureKeys}
                     || CASE WHEN coalesce(capture->'user_set', '{}'::jsonb) <> '{}'::jsonb
                             THEN jsonb_build_object('resolved_by', 'user') ELSE '{}'::jsonb END,
           updated_at = now()
     WHERE id = ${id}::uuid AND capture_status = 'reading'`);
}

async function readCapture(id: string): Promise<void> {
  const rows = await db.execute(sql`
    SELECT workspace_id, image_path, notes, title, capture ? 'sibling_of' AS is_sibling,
           capture->'retry_of'->'reading'->>'title' AS read_title
      FROM wish_items WHERE id = ${id}::uuid AND capture_status = 'reading'`);
  const row = rows.rows[0] as
    | { workspace_id: string; image_path: string | null; notes: string | null; title: string; is_sibling: boolean; read_title: string | null }
    | undefined;
  if (!row?.image_path) return; // deleted, or no longer waiting
  // A wish split from a list (its original deleted, so retried on its
  // own): the reading is about its entry, and the list is not split again.
  const focus = row.is_sibling
    ? ([WISH_TITLE_WHILE_READING, WISH_TITLE_UNREAD].includes(row.title) ? row.read_title : row.title) ?? row.read_title
    : null;
  const abs = resolveInside(wishImageRoot(), row.image_path);
  if (!abs) return failCapture(id, { error: "image_missing" });

  const sessionId = randomUUID();
  const model = process.env.CLAUDE_MODEL || null;
  const base = { session_id: sessionId, model_requested: model, read_at: new Date().toISOString(), prompt_version: WISH_READ_PROMPT_VERSION };
  console.log(`[wish] read capture=${id} sessionId=${sessionId}`);
  let stdout: string;
  try {
    const args = ["--output-format", "text"];
    if (model) args.push("--model", model);
    ({ stdout } = await runClaude(buildWishReadPrompt(abs, row.notes, focus), { profile: "image_read", args, timeoutMs: READ_TIMEOUT_MS, sessionId }));
  } catch (err) {
    console.error(`[wish] capture=${id} FAILED:`, (err as Error).message.slice(0, 300));
    return failCapture(id, { ...base, error: "agent_error", detail: (err as Error).message.slice(0, 300) });
  }
  const parsed = parseWishReading(stdout);
  if (!parsed.ok) return failCapture(id, { ...base, error: parsed.reason, detail: parsed.detail });
  const r = parsed.reading;
  if (r.kind === "none") {
    // Read, and nothing to save: the title says what it showed.
    return failCapture(id, { ...base, error: "nothing_to_save", detail: r.title, reading: r }, r.title);
  }

  // What the person changed while the image was being read is theirs.
  const now = await db.execute(sql`SELECT kind, capture FROM wish_items WHERE id = ${id}::uuid AND capture_status = 'reading'`);
  const cur = now.rows[0] as { kind: string; capture: unknown } | undefined;
  if (!cur) return;
  const userSet = userSetOf(cur.capture);
  const kind = userSet.kind ? cur.kind : r.kind;
  const match = kind === "place" && !userSet.place ? await matchPlace(row.workspace_id, r, r.confidence) : null;
  if (match?.error) console.warn(`[wish] capture=${id} place not linked: ${match.error}`);
  else if (match?.tentative) console.log(`[wish] capture=${id} place suggested, not linked (${match.tentative_reason}): ${match.name ?? "?"}`);

  // Only a row still waiting is written, and inside it nothing the person
  // set by hand (`capture.user_set`): a title, the kind, the place.
  const upd = await db.execute(sql`
    UPDATE wish_items
       SET kind = CASE WHEN capture->'user_set' ? 'kind' THEN kind ELSE ${r.kind} END,
           title = CASE WHEN capture->'user_set' ? 'title' THEN title ELSE ${r.title} END,
           notes = coalesce(notes, ${r.note}),
           source_url = coalesce(source_url, ${r.source_url}),
           target_price_minor = CASE WHEN ${kind} = 'thing' THEN coalesce(target_price_minor, ${r.price_minor}::int) ELSE target_price_minor END,
           currency = CASE WHEN ${kind} = 'thing' AND ${r.currency}::text IS NOT NULL THEN ${r.currency} ELSE currency END,
           place_id = CASE WHEN capture->'user_set' ? 'place' THEN place_id
                           WHEN ${kind} = 'place' THEN ${match?.place_id ?? null}::uuid
                           ELSE NULL END,
           capture_status = 'done',
           capture = ${JSON.stringify({ ...base, reading: r, place_match: match })}::jsonb || ${keepCaptureKeys},
           updated_at = now()
     WHERE id = ${id}::uuid AND capture_status = 'reading'
    RETURNING id, place_id, capture ? 'siblings' AS has_siblings, capture ? 'sibling_of' AS is_sibling`);
  const done = upd.rows[0] as { id: string; place_id: string | null; has_siblings: boolean; is_sibling: boolean } | undefined;
  if (!done) return;
  if (done.place_id) {
    await markDuplicate(id, row.workspace_id, done.place_id);
    // Been there already since the wish was made? Usually not.
    await settleWishesSafely({ wishIds: [id] });
  }
  if (r.others.length > 0 && !done.has_siblings && !done.is_sibling) await splitSiblings(id, row.workspace_id, r, base);
}

/**
 * A place the workspace already wishes for, saved again from another
 * image (a second screenshot of the same listing): the new wish names the
 * earlier one in `capture.duplicate_of`, so a client can offer to merge
 * them. The wish itself stays: its id is what the uploader is polling.
 * Split wishes skip such a place instead (`others_skipped`).
 */
async function markDuplicate(id: string, workspaceId: string, placeId: string): Promise<void> {
  const res = await db.execute(sql`
    UPDATE wish_items w
       SET capture = w.capture || jsonb_build_object('duplicate_of', d.id)
      FROM (SELECT o.id FROM wish_items o
             WHERE o.workspace_id = ${workspaceId}::uuid AND o.place_id = ${placeId}::uuid
               AND o.id <> ${id}::uuid AND o.status <> 'declined'
               AND o.created_at <= (SELECT created_at FROM wish_items WHERE id = ${id}::uuid)
             ORDER BY o.created_at, o.id LIMIT 1) d
     WHERE w.id = ${id}::uuid
    RETURNING d.id`);
  const dup = (res.rows[0] as { id: string } | undefined)?.id;
  if (dup) console.log(`[wish] capture=${id} is a place already wished for: wish=${dup}`);
}

/**
 * A post that lists several places with equal weight: one wish for each
 * of the others, sharing the image and pointing back with
 * `capture.sibling_of`; the first wish lists them in `capture.siblings`.
 * A place the workspace already has a wish for is not wished for twice
 * (`capture.others_skipped`). Done once per capture: reading it again does
 * not split it again.
 */
async function splitSiblings(id: string, workspaceId: string, r: WishReading, base: Record<string, unknown>): Promise<void> {
  const src = await db.execute(sql`
    SELECT image_path, image_sha256, image_mime_type, capture->'converted_from' AS converted_from FROM wish_items WHERE id = ${id}::uuid`);
  const img = src.rows[0] as { image_path: string; image_sha256: string; image_mime_type: string; converted_from: unknown } | undefined;
  if (!img) return;
  const siblings: string[] = [];
  const skipped: { title: string; reason: string; wish_id?: string }[] = [];
  for (const o of r.others as WishReadingOther[]) {
    // A list post usually names its city once ("3 NYC spots"): an entry
    // with no place of its own is in the main one's.
    const where = o.locality || o.address ? o : { ...o, locality: r.locality };
    const match = r.kind === "place" ? await matchPlace(workspaceId, where, r.confidence) : null;
    if (match?.place_id) {
      const dup = await db.execute(sql`
        SELECT id FROM wish_items WHERE workspace_id = ${workspaceId}::uuid AND place_id = ${match.place_id}::uuid AND status <> 'declined' LIMIT 1`);
      const dupId = (dup.rows[0] as { id: string } | undefined)?.id;
      if (dupId) {
        skipped.push({ title: o.title, reason: "already_wished", wish_id: dupId });
        continue;
      }
    }
    const sid = randomUUID();
    const capture = {
      ...base,
      sibling_of: id,
      reading: { kind: r.kind, ...o, recommended_by: r.recommended_by, source_app: r.source_app, confidence: r.confidence },
      place_match: match,
      ...(img.converted_from ? { converted_from: img.converted_from } : {}),
    };
    await db.execute(sql`
      INSERT INTO wish_items (id, workspace_id, kind, title, notes, place_id, source_url, image_path, image_sha256, image_mime_type, capture_status, capture)
      VALUES (${sid}::uuid, ${workspaceId}::uuid, ${r.kind}, ${o.title}, ${o.note}, ${match?.place_id ?? null}::uuid, ${r.source_url},
              ${img.image_path}, ${img.image_sha256}, ${img.image_mime_type}, 'done', ${JSON.stringify(capture)}::jsonb)`);
    siblings.push(sid);
    console.log(`[wish] capture=${id} split: wish=${sid} "${o.title.slice(0, 60)}"`);
    if (match?.place_id) await settleWishesSafely({ wishIds: [sid] });
  }
  await db.execute(sql`
    UPDATE wish_items
       SET capture = coalesce(capture, '{}'::jsonb)
                     || jsonb_build_object('siblings', ${JSON.stringify(siblings)}::jsonb)
                     || CASE WHEN ${skipped.length} > 0 THEN jsonb_build_object('others_skipped', ${JSON.stringify(skipped)}::jsonb) ELSE '{}'::jsonb END,
           updated_at = now()
     WHERE id = ${id}::uuid`);
}
