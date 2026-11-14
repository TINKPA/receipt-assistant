import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  smallint,
  bigint,
  index,
  uniqueIndex,
  check,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  agentRunKindEnum,
  agentRunOutcomeEnum,
  agentRunStatusEnum,
} from "./enums.js";
import { workspaces } from "./workspaces.js";
import { ingests } from "./ingests.js";
import { documents } from "./documents.js";
import { transactions } from "./transactions.js";
import { derivationEvents } from "./derivation_events.js";
import { documentExtractions } from "./document_extractions.js";

/**
 * One row per `claude -p` run the server starts for a document: every
 * ingest extraction and every re-extract, including the ones that fail
 * before the agent writes anything. Written only by the server
 * (`src/ingest/runs.ts`); the extraction agent's role has no grant on
 * it, and Ask's read-only role reads it like every other table.
 *
 * Why it exists: before this table the only record of a run was its
 * session transcript, found by grepping for the ingest id, and the
 * transcript is missing exactly when the run failed earliest (an auth
 * failure leaves none). The model was recorded as whatever
 * `CLAUDE_MODEL` said, `cli-default` when unset, never what ran.
 *
 * Lifecycle (wave 1, P1):
 *   - The worker inserts the row `running` in the same transaction that
 *     moves the ingest to `processing` and points `ingests.current_run_id`
 *     at it, BEFORE spawning, with a session id it minted itself. So a
 *     run that dies at once still has its row and its session id.
 *   - After the child exits the row becomes `finished`, with `outcome`,
 *     `error_class`, exit code or signal, and the turns, tokens and
 *     observed model that `summarizeSession` reads from the transcript.
 *   - At boot every row still `running` becomes `abandoned` with outcome
 *     `interrupted`: the process that owned it is gone.
 *   - Re-extract writes `kind='re_extract'` rows the same way, with the
 *     transaction it targets, the snapshot taken before the spawn
 *     (`before`), what the run left (`result`) and the
 *     `derivation_events` row it wrote.
 *
 * Several columns are created now so the later phases of wave 1 only
 * add constraints: the lease and heartbeat (durable queue), the
 * `extraction_id` (its foreign key came with `document_extractions` in
 * 0043), `repair_rounds`, `apply_report`. They stay NULL / 0 until the
 * phase that writes them.
 *
 * `error_class` vocabulary (text, not an enum, so a class can be added
 * without a migration):
 *   auth | quota | overloaded | timeout | spawn | crash   the child failed
 *   agent_reported   the agent closed the ingest as `error` itself, or a
 *                    re-extract agent ended with `ERROR <reason>`
 *   guard            a worker guard (#125 / #134) refused what the agent
 *                    reported
 *   no_closeout      the agent exited 0 without closing the ingest
 *   apply            the server's own step after the agent failed, or
 *                    (server writer) the apply transaction failed
 *   config           the run could not be set up (missing workspace, …)
 *   artefact_missing the server writer's agent handed back no record
 *   artefact_invalid its record was still invalid after the repair rounds
 *   fenced_out       the run no longer owned its ingest when it went to
 *                    store or apply its record
 *   shutdown | stall reserved for the durable queue
 *   An abandoned run carries `crash`: nothing marked a clean shutdown.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: agentRunKindEnum("kind").notNull(),
    status: agentRunStatusEnum("status").notNull(),
    ingestId: uuid("ingest_id").references((): AnyPgColumn => ingests.id, {
      onDelete: "set null",
    }),
    documentId: uuid("document_id").references((): AnyPgColumn => documents.id, {
      onDelete: "set null",
    }),
    /** Re-extract: the transaction the run updates. */
    transactionId: uuid("transaction_id").references(
      (): AnyPgColumn => transactions.id,
      { onDelete: "set null" },
    ),
    attempt: integer("attempt").notNull().default(1),
    /** upload | retry | api | auto_retry | recovery | apply_only */
    trigger: text("trigger").notNull(),
    /** Which code path wrote the ledger: the agent's own SQL (`agent_sql`),
     *  the server applier (`server_apply`, wave 1; also a sandbox record
     *  stub's runs), or a legacy sandbox stub that wrote it itself (`stub`). */
    writer: text("writer").notNull(),
    /** Minted by the server before the spawn; NULL only when nothing was
     *  spawned. Names the transcript (`getSessionJsonlPath`). */
    sessionId: uuid("session_id"),
    workerId: text("worker_id"),
    promptVersion: text("prompt_version").notNull(),
    promptGitSha: text("prompt_git_sha").notNull(),
    promptBytes: integer("prompt_bytes"),
    /** `CLAUDE_MODEL` at spawn time; NULL when unset (the CLI's default). */
    modelRequested: text("model_requested"),
    /** The model the transcript says answered. */
    modelObserved: text("model_observed"),
    /** `claude --version`, read once at boot. */
    cliVersion: text("cli_version"),
    queuedAt: timestamp("queued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    exitSignal: text("exit_signal"),
    outcome: agentRunOutcomeEnum("outcome"),
    errorClass: text("error_class"),
    /** ≤ 2000 chars, the same text the ingest row gets. */
    error: text("error"),
    repairRounds: smallint("repair_rounds").notNull().default(0),
    turns: integer("turns"),
    toolCalls: integer("tool_calls"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    transcriptBytes: bigint("transcript_bytes", { mode: "number" }),
    produced: jsonb("produced"),
    agentReport: jsonb("agent_report"),
    applyReport: jsonb("apply_report"),
    /** The extraction record this run handed back (`document_extractions`,
     *  wave 1, P2), set in the transaction that stores it. */
    extractionId: uuid("extraction_id"),
    before: jsonb("before"),
    result: jsonb("result"),
    derivationEventId: uuid("derivation_event_id").references(
      (): AnyPgColumn => derivationEvents.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("agent_runs_session_uq")
      .on(t.sessionId)
      .where(sql`session_id IS NOT NULL`),
    index("agent_runs_ingest_idx").on(t.ingestId, t.startedAt.desc()),
    index("agent_runs_document_idx").on(t.documentId, t.startedAt.desc()),
    index("agent_runs_arm_idx").on(t.kind, t.writer, t.promptVersion, t.startedAt),
    index("agent_runs_running_idx")
      .on(t.startedAt)
      .where(sql`status = 'running'`),
    check(
      "agent_runs_writer_check",
      sql`${t.writer} IN ('agent_sql','server_apply','stub')`,
    ),
    // Declared here rather than with `.references()` so the constraint
    // keeps the name migration 0043 gives it.
    foreignKey({
      name: "agent_runs_extraction_fk",
      columns: [t.extractionId],
      foreignColumns: [documentExtractions.id],
    }).onDelete("set null"),
  ],
);
