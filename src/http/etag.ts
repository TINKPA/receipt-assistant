/**
 * Weak-ETag helpers for optimistic-concurrency-controlled resources.
 *
 * Format: `W/"<version>"` where `<version>` is the monotonic `version`
 * column maintained by the `bump_version` DB trigger.
 *
 * Mutations (PATCH/DELETE/void) MUST carry `If-Match`; missing → 428,
 * mismatch → 412. GET accepts optional `If-None-Match` → 304 on match.
 *
 * A resource with no `version` column must not invent a constant one:
 * a tag that never moves turns every revalidation into a 304 and pins
 * the first body a client ever saw. Use `representationEtag` /
 * `sendWithRepresentationEtag` for those — the tag is a digest of the
 * response body, so it moves exactly when the body does.
 *
 * The same failure has a second form: a `version` that is real but does
 * not cover everything the response says. A transaction's body lists its
 * documents and its version does not move when they do; its tag is
 * `transactionEtag`, below.
 */
import type { Request, Response } from "express";
import { createHash } from "crypto";
import {
  PreconditionRequiredProblem,
  VersionMismatchProblem,
} from "./problem.js";

export function formatEtag(version: number): string {
  return `W/"${version}"`;
}

export function parseEtag(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^\s*W\/"(\d+)"\s*$/.exec(header);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Emit the ETag header on a resource response. */
export function setEtag(res: Response, version: number): void {
  res.setHeader("ETag", formatEtag(version));
}

/**
 * Enforce If-Match on a mutation endpoint.
 * Throws HttpProblem on missing / malformed / mismatched tag.
 *
 * `parse` reads the version out of the tag; transactions pass
 * `parseTransactionEtag`, whose tags carry more than the version.
 */
export function requireIfMatch(
  req: Request,
  currentVersion: number,
  parse: (header: string | undefined) => number | null = parseEtag,
): void {
  const header = req.header("If-Match");
  if (!header) throw new PreconditionRequiredProblem("If-Match");
  const supplied = parse(header);
  if (supplied === null || supplied !== currentVersion) {
    throw new VersionMismatchProblem(currentVersion, supplied ?? undefined);
  }
}

/**
 * Handle If-None-Match on a GET. Returns true if a 304 was sent;
 * the caller should `return` immediately on true.
 */
export function handleIfNoneMatch(
  req: Request,
  res: Response,
  currentVersion: number,
): boolean {
  const header = req.header("If-None-Match");
  if (!header) return false;
  const supplied = parseEtag(header);
  if (supplied !== null && supplied === currentVersion) {
    res.status(304).end();
    return true;
  }
  return false;
}

// ── Transactions: the version, plus the state of the linked documents ──

/**
 * ETag of a transaction: `W/"<version>-<documents tag>"`.
 *
 * A transaction's representation embeds its `documents` (id and
 * `deleted_at` of every linked one), and none of the writes that change
 * that list touch the transaction row: soft-deleting or restoring a
 * document, linking or unlinking one, a cascade delete that keeps the
 * transaction, a dedup apply or undo moving links onto or off the
 * surviving row, an upload resurrecting a soft-deleted document, the
 * extraction agent attaching a new file to an existing transaction with
 * its own `psql`. `version` stays where it was through all of them, so a
 * tag made of the version alone answered a revalidating browser with 304
 * and left the receipt page showing documents that were gone.
 *
 * The documents tag is DERIVED when the response is built, not written
 * by those paths. A version bump would have to be added to each of them
 * (one of which is prompt SQL), would take the transaction's row lock
 * from document operations that have no other reason to hold it, and
 * would be forgotten by the next writer. A value computed from what the
 * response is about to say cannot be forgotten.
 *
 * It is always present, even for a transaction with no documents, so
 * that a copy cached under the older `W/"<version>"` form revalidates
 * once instead of matching by accident.
 *
 * Documents are the only embedded part it covers. `items` (added by
 * `POST …/items` without a version bump) and the `merchant` / `place`
 * blocks (renamed in their own tables) can still change under an
 * unchanged tag; they belong in here when that is taken on.
 *
 * `If-Match` reads the VERSION PART ONLY (`parseTransactionEtag`): it
 * guards writes to the transaction row, and a document change is not
 * one. A client that read the transaction, saw a document deleted
 * elsewhere, and then saves an edit has that edit applied, and the
 * response carries the current documents and the current tag; nothing
 * is lost and nothing is refused that the row lock would have allowed.
 * The bare `W/"<version>"` form stays valid in `If-Match` for the same
 * reason, which is what a client holding only the body's `version` (a
 * bulk `if_match`, a script) sends.
 */
export function transactionEtag(
  version: number,
  documents: ReadonlyArray<{ id: string; deleted_at: string | null }>,
): string {
  const state = documents
    .map((d) => `${d.id}:${d.deleted_at ?? ""}`)
    .sort()
    .join("|");
  const tag = createHash("sha256").update(state).digest("base64url").slice(0, 12);
  return `W/"${version}-${tag}"`;
}

/** The version a transaction ETag names, in either form it has had:
 *  `W/"<version>-<documents tag>"` or the bare `W/"<version>"`. */
export function parseTransactionEtag(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^\s*W\/"(\d+)(?:-[A-Za-z0-9_-]+)?"\s*$/.exec(header);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ── Resources without a `version` column ───────────────────────────────

/**
 * Weak ETag derived from the JSON a response is about to carry. It is a
 * caching token only: it says nothing about write ordering, so
 * `requireIfMatch` does not accept it.
 */
export function representationEtag(body: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(body) ?? "")
    .digest("base64url")
    .slice(0, 27);
  return `W/"${digest}"`;
}

/** `If-None-Match` comparison is always weak (RFC 9110 §13.1.2). */
function opaque(tag: string): string {
  return tag.trim().replace(/^W\//, "");
}

/** True when `If-None-Match` lists `etag`, or is `*`. */
export function ifNoneMatchSatisfied(req: Request, etag: string): boolean {
  const header = req.header("If-None-Match");
  if (!header) return false;
  if (header.trim() === "*") return true;
  const want = opaque(etag);
  return header.split(",").some((candidate) => opaque(candidate) === want);
}

/**
 * Send `body` as JSON under an ETag computed from it — or a bare 304
 * when the client already holds that exact representation.
 */
export function sendWithRepresentationEtag(
  req: Request,
  res: Response,
  body: unknown,
): void {
  const etag = representationEtag(body);
  res.setHeader("ETag", etag);
  if (ifNoneMatchSatisfied(req, etag)) {
    res.status(304).end();
    return;
  }
  res.json(body);
}
