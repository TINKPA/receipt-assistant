/**
 * Why a person must look at what a record booked, read from the record's
 * own validation report (wave 1; docs/server-writer.md, "Review flags from
 * the reading"). Pure: the report is what T1 stored on
 * `document_extractions.validation`.
 *
 * The reasons, in this order:
 *
 *   - every entry of the record's `audit.review_flags` (the validator's
 *     `review_flag_<flag>` warnings): the reading itself says a person
 *     should look, and the prompt tells the agent so. `date_unresolved` is
 *     the owner's rule that a date the document does not print is never
 *     booked silently, whatever the date: the lessons have the agent book
 *     an upload date or a file's mtime that way when nothing is printed.
 *     When the date is also after the upload (the warning
 *     `future_date_unresolved`), the reason says it is booked as printed.
 *   - a repair round changed `facts.occurred_on`, `facts.occurred_at` or a
 *     money field (`isMoneyPath`). Only the model's second reading stands
 *     behind such a change; a round asked to re-read a future date once
 *     answered by moving the year to one printed nowhere.
 *
 * An insert carries the reasons as a review flag (`flagForReview`, the
 * queue a mixed tender uses); an attach books nothing new, so the apply
 * only notes them in `apply_report.review.noted`.
 */
import { REVIEW_FLAGS } from "../contract/v1.js";
import type { ValidationReport } from "../contract/validate.js";

type ReviewFlag = (typeof REVIEW_FLAGS)[number];

/** The reason for a date after the upload, booked as printed. */
export const FUTURE_DATE_REVIEW =
  "date after the upload, booked as printed: the document prints it and the reading flagged it date_unresolved";

/** The reason for each flag the reading may raise (`audit.review_flags`). */
export const REVIEW_FLAG_REASONS: Record<ReviewFlag, string> = {
  date_unresolved: "the reading could not confirm the date (date_unresolved): check it against the document",
  total_unresolved: "the reading could not confirm the total (total_unresolved): check it against the document",
  handwritten_amount: "an amount on the document is handwritten (handwritten_amount): check the total and the tip",
  partial_document: "the document is partial or cut off (partial_document): check that nothing is missing",
  needs_review: "the reading asked for a person to look (needs_review): its note is in ocr_audit.note",
};

const DATE_PATHS: ReadonlySet<string> = new Set(["facts.occurred_on", "facts.occurred_at"]);

/** Paths a reason names, at most this many; the rest are counted. */
const PATHS_SHOWN = 5;

/** The review reasons of a stored record, in a fixed order; empty when
 *  nothing needs a person. A report without `repairs[].changed` (written
 *  before rounds recorded it) gives no repair reason. */
export function recordReviewReasons(report: ValidationReport | null | undefined): string[] {
  if (!report) return [];
  const reasons: string[] = [];
  const warned = new Set(report.warnings.map((w) => w.rule));
  for (const flag of REVIEW_FLAGS) {
    if (!warned.has(`review_flag_${flag}`)) continue;
    reasons.push(flag === "date_unresolved" && warned.has("future_date_unresolved") ? FUTURE_DATE_REVIEW : REVIEW_FLAG_REASONS[flag]);
  }
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
