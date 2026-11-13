/**
 * Postgres error → HTTP status, in one place.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose
 * `message` is the full statement plus its bound parameters, and hangs
 * the node-postgres `DatabaseError` on `.cause`. The message must never
 * reach a response; the SQLSTATE on the cause is what says whose fault
 * the failure was. `problemHandler` calls `classifyPgError` for every
 * error that is not already an `HttpProblem`.
 *
 * What a mapped response may carry: the constraint / column name and,
 * for an exception our own triggers raised, the trigger's sentence.
 * Never `detail`, `where`, `internalQuery` or the primary message of a
 * built-in error — those quote row values and parameters.
 */

/** The fields of a node-postgres `DatabaseError` this module reads. */
export interface PgErrorInfo {
  /** Five-character SQLSTATE. */
  code: string;
  /** Primary message. Quotes client values for class 22 — log it, do not send it. */
  message: string;
  constraint?: string;
  table?: string;
  column?: string;
  /** Backend C function that raised it; `exec_stmt_raise` = PL/pgSQL `RAISE`. */
  routine?: string;
}

/** What `problemHandler` should answer for a classified Postgres error. */
export interface PgProblemSpec {
  status: number;
  /** Suffix of the problem `type` URI. */
  type: string;
  title: string;
  detail: string;
  extras: Record<string, unknown>;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/**
 * Find the Postgres error in `err` or anywhere down its `cause` chain.
 *
 * A SQLSTATE alone is not proof: Node's own `EPIPE` / `EBUSY` / `ELOOP`
 * are also five capitals. A server-sent error always carries `severity`,
 * which no Node system error does.
 */
export function findPgError(err: unknown): PgErrorInfo | null {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 8; depth++) {
    const e = cur as Record<string, unknown>;
    if (
      typeof e.code === "string" &&
      SQLSTATE_RE.test(e.code) &&
      typeof e.severity === "string"
    ) {
      return {
        code: e.code,
        message: typeof e.message === "string" ? e.message : "",
        constraint: typeof e.constraint === "string" ? e.constraint : undefined,
        table: typeof e.table === "string" ? e.table : undefined,
        column: typeof e.column === "string" ? e.column : undefined,
        routine: typeof e.routine === "string" ? e.routine : undefined,
      };
    }
    cur = e.cause;
  }
  return null;
}

/**
 * Class 22 codes that mean "the value you sent cannot be that type".
 * Deliberately not the whole class: `22012` division by zero or `22004`
 * null not allowed are faults in our SQL, and stay a 500.
 */
const MALFORMED_VALUE_CODES = new Set([
  "22P02", // invalid_text_representation — a malformed uuid, enum label, integer, json
  "22P03", // invalid_binary_representation
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  "22003", // numeric_value_out_of_range
  "22001", // string_data_right_truncation
  "22021", // character_not_in_repertoire — e.g. a NUL byte in a text value
  "2201W", // invalid_row_count_in_limit_clause
  "2201X", // invalid_row_count_in_result_offset_clause
]);

function named(pg: PgErrorInfo): Record<string, unknown> {
  return {
    ...(pg.constraint ? { constraint: pg.constraint } : {}),
    ...(pg.column ? { column: pg.column } : {}),
  };
}

/**
 * Map a Postgres error to the response it deserves, or `null` when the
 * failure is ours (syntax error, missing column, lost connection, …) and
 * the caller should answer a generic 500.
 */
export function classifyPgError(pg: PgErrorInfo): PgProblemSpec | null {
  if (MALFORMED_VALUE_CODES.has(pg.code)) {
    // `invalid input syntax for type uuid: "…"` / `invalid input value
    // for enum txn_status: "…"` — keep the type name, drop the value.
    const m = /for (?:type|enum) ([a-z_][a-z0-9_ ]*)/i.exec(pg.message);
    const valueType = m ? m[1]!.trim() : undefined;
    return {
      status: 400,
      type: "invalid-parameter",
      title: "Malformed value",
      detail: valueType
        ? `A value in the request is not a valid ${valueType}.`
        : "A value in the request is malformed or out of range for its type.",
      extras: valueType ? { value_type: valueType } : {},
    };
  }

  switch (pg.code) {
    case "23505": // unique_violation
    case "23P01": // exclusion_violation
      return {
        status: 409,
        type: "conflict",
        title: "Conflicts with an existing record",
        detail:
          "The request would duplicate a record that must be unique. Fetch the current state and retry.",
        extras: named(pg),
      };

    case "23503": {
      // foreign_key_violation has two opposite meanings, told apart only
      // by the primary message: writing a reference to a row that does
      // not exist (the request names something unknown → 422), or
      // removing a row something still points at (state conflict → 409).
      if (/^insert or update on table/i.test(pg.message)) {
        return {
          status: 422,
          type: "invalid-reference",
          title: "Referenced record does not exist",
          detail:
            "The request refers to another record by id, and no such record exists.",
          extras: named(pg),
        };
      }
      return {
        status: 409,
        type: "still-referenced",
        title: "Record is still referenced",
        detail:
          "Other records still refer to this one. Remove or re-point them first.",
        extras: named(pg),
      };
    }

    case "23514": {
      // check_violation. Our ledger triggers raise it with a sentence
      // written for the caller ("Postings for transaction … do not
      // balance"); a built-in CHECK failure's message only names the
      // relation and constraint, which `extras` already carries.
      const fromTrigger = pg.routine === "exec_stmt_raise" && pg.message !== "";
      return {
        status: 422,
        type: "constraint-violation",
        title: "Value violates a data rule",
        detail: fromTrigger
          ? pg.message
          : "A value in the request breaks a rule the ledger enforces.",
        extras: named(pg),
      };
    }

    case "23502": // not_null_violation
      return {
        status: 422,
        type: "constraint-violation",
        title: "Required value missing",
        detail: "A required value is missing or null.",
        extras: named(pg),
      };

    default:
      return null;
  }
}
