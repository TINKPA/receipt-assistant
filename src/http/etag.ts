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
 */
export function requireIfMatch(req: Request, currentVersion: number): void {
  const header = req.header("If-Match");
  if (!header) throw new PreconditionRequiredProblem("If-Match");
  const supplied = parseEtag(header);
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
