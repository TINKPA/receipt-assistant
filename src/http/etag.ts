/**
 * Weak-ETag helpers for optimistic-concurrency-controlled resources.
 *
 * Format: `W/"<version>"` where `<version>` is the monotonic `version`
 * column maintained by the `bump_version` DB trigger.
 *
 * Mutations (PATCH/DELETE/void) MUST carry `If-Match`; missing → 428,
 * mismatch → 412. GET accepts optional `If-None-Match` → 304 on match.
 */
import type { Request, Response } from "express";
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
