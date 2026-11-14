/**
 * Why a person must look at what a record booked, read from the record's
 * own validation report (wave 1; docs/server-writer.md, "Review flags from
 * the reading"). Pure: the report is what T1 stored on
 * `document_extractions.validation`.
 *
 * Two reasons, both the owner's rule that a date the document does not
 * print is never booked silently:
 *
 *   - `future_date_unresolved`: the document prints a date after its
 *     upload, the agent kept it and flagged it `date_unresolved`, and it is
 *     booked as printed.
 *   - a repair round changed `facts.occurred_on`, `facts.occurred_at` or a
 *     money field (`isMoneyPath`). Only the model's second reading stands
 *     behind such a change; a round asked to re-read a future date once
 *     answered by moving the year to one printed nowhere.
 *
 * An insert carries the reasons as a review flag (`flagForReview`, the
 * queue a mixed tender uses); an attach books nothing new, so the apply
 * only notes them in `apply_report.review.noted`.
 */
import type { ValidationReport } from "../contract/validate.js";

/** The reason for a date after the upload, booked as printed. */
export const FUTURE_DATE_REVIEW =
  "date after the upload, booked as printed: the document prints it and the reading flagged it date_unresolved";

const DATE_PATHS: ReadonlySet<string> = new Set(["facts.occurred_on", "facts.occurred_at"]);

/** Paths a reason names, at most this many; the rest are counted. */
const PATHS_SHOWN = 5;

/** The review reasons of a stored record, in a fixed order; empty when
 *  nothing needs a person. A report without `repairs[].changed` (written
 *  before rounds recorded it) gives no repair reason. */
export function recordReviewReasons(report: ValidationReport | null | undefined): string[] {
  if (!report) return [];
  const reasons: string[] = [];
  if (report.warnings.some((w) => w.rule === "future_date_unresolved")) reasons.push(FUTURE_DATE_REVIEW);
  const moved = new Set<string>();
  for (const round of report.repairs ?? []) {
    for (const c of round.changed ?? []) {
      if (DATE_PATHS.has(c.path) || c.money) moved.add(c.path);
    }
  }
  if (moved.size > 0) {
    const paths = [...moved].sort();
    const shown = paths.slice(0, PATHS_SHOWN).join(", ");
    const more = paths.length > PATHS_SHOWN ? ` and ${paths.length - PATHS_SHOWN} more` : "";
    reasons.push(`a repair round changed ${shown}${more}: check against the document`);
  }
  return reasons;
}
