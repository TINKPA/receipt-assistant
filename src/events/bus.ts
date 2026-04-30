/**
 * Named event bus singleton — in-process pub/sub for ingest/reconcile
 * lifecycle events.
 *
 * Scope: this file has **no DB dependency** and no external I/O. It is a
 * thin wrapper around Node's built-in `EventEmitter` so multiple emitters
 * (the ingest worker, the future reconcile module) can publish to a
 * single well-known channel that the SSE route subscribes to.
 *
 * Event catalog (Phase 2 of issue #32):
 *
 *   job.started        { ingestId }
 *   job.done           { ingestId, classification, produced }
 *   job.error          { ingestId, error }
 *   batch.extracted    { batchId, counts }
 *   batch.status       { batchId, status, counts }        // catch-up
 *   batch.failed       { batchId }                        // terminal
 *   batch.reconciled   { batchId }                        // terminal
 *   reconcile.started  { batchId }
 *   reconcile.proposal { id, kind, payload, score, auto_applied }
 *   reconcile.done     { batchId, applied, proposals }
 *
 * The worker emits `job.*` and `batch.*`. A future reconcile module is
 * responsible for the `reconcile.*` names; the SSE route subscribes
 * defensively so if nothing publishes, nothing fires — the stream
 * simply stays open with keepalives.
 *
 * Event names are string literals on purpose: the type alias below
 * exists to help authoring but `emit` accepts any string so the
 * reconcile module can add a name without editing this file. Keeping
 * this file append-only is the point.
 */
import { EventEmitter } from "node:events";

// ── Payload shapes ────────────────────────────────────────────────────

export interface BatchCountsPayload {
  total: number;
  queued: number;
  processing: number;
  done: number;
  error: number;
  unsupported: number;
}

export interface JobStartedPayload {
  batchId: string;
  ingestId: string;
}

export interface JobDonePayload {
  batchId: string;
  ingestId: string;
  classification: string;
  produced: {
    receipt_ids: string[];
    transaction_ids: string[];
    document_ids: string[];
  };
}

export interface JobErrorPayload {
  batchId: string;
  ingestId: string;
  error: string;
}

export interface BatchExtractedPayload {
  batchId: string;
  counts: BatchCountsPayload;
}

export interface BatchStatusPayload {
  batchId: string;
  status: string;
  counts: BatchCountsPayload;
}

export interface BatchFailedPayload {
  batchId: string;
  counts: BatchCountsPayload;
}

export interface BatchReconciledPayload {
  batchId: string;
}

export interface ReconcileStartedPayload {
  batchId: string;
}

export interface ReconcileProposalPayload {
  batchId: string;
  id: string;
  kind: string;
  payload: unknown;
  score: number | null;
  auto_applied: boolean;
}

export interface ReconcileDonePayload {
  batchId: string;
  applied: number;
  proposals: number;
}

// ── Event name union (authoring aid only; string literals in practice) ─

export type BusEvent =
  | "job.started"
  | "job.done"
  | "job.error"
  | "batch.extracted"
  | "batch.status"
  | "batch.failed"
  | "batch.reconciled"
  | "reconcile.started"
  | "reconcile.proposal"
  | "reconcile.done";

// ── Singleton ─────────────────────────────────────────────────────────

const emitter = new EventEmitter();
// Batches may have many concurrent SSE subscribers + the worker. The
// default cap of 10 would warn on a modestly-popular batch. 0 = unbounded.
emitter.setMaxListeners(0);

/**
 * Publish an event. Keep the payload shape cohesive per event name
 * (see the interfaces above) but the bus itself is untyped — intentional,
 * so new event kinds (reconcile.*) can land without editing this file.
 */
export function emit(event: string, payload: unknown): void {
  emitter.emit(event, payload);
}

/**
 * Subscribe to an event. Returns an unsubscribe thunk so callers
 * (notably the SSE route) can clean up on client disconnect with
 * a single call — no need to remember the handler reference.
 */
export function on(
  event: string,
  handler: (payload: unknown) => void,
): () => void {
  emitter.on(event, handler);
  return () => {
    emitter.off(event, handler);
  };
}
