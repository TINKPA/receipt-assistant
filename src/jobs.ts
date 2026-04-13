import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import { processReceipt, getSessionJsonlPath } from "./claude.js";
import { insertReceiptPlaceholder, updateReceiptStatus, getReceipt, updateReceiptGeocode } from "./db.js";
import { ingestSession } from "./langfuse.js";
import { geocodeReceipt } from "./geocode.js";

// ── Job Store + Event Bus ────────────────────────────────────────────

export type JobStatus = "queued" | "done" | "error";

export interface JobEvent {
  type: "queued" | "done" | "error";
  data: any;
}

export interface Job {
  id: string;
  receiptId: string;
  imagePath: string;
  notes?: string;
  status: JobStatus;
  error?: string;
  createdAt: string;
}

const jobs = new Map<string, Job>();
const bus = new EventEmitter();
bus.setMaxListeners(100); // allow many SSE clients

const MAX_CONCURRENCY = parseInt(process.env.MAX_CLAUDE_CONCURRENCY || "3");
let running = 0;
const queue: string[] = [];

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

/**
 * Subscribe to events for a specific job.
 * Callback fires for each state change. Returns unsubscribe function.
 */
export function subscribeJob(jobId: string, cb: (event: JobEvent) => void): () => void {
  const handler = (event: JobEvent) => cb(event);
  bus.on(jobId, handler);
  return () => bus.off(jobId, handler);
}

function emit(jobId: string, event: JobEvent) {
  const job = jobs.get(jobId);
  if (job) job.status = event.type;
  bus.emit(jobId, event);
}

/**
 * Geocode the merchant location and persist it. Runs after the
 * extraction pipeline has already marked the receipt as 'done'.
 * Failures are swallowed — this must never flip status back to error.
 */
async function runGeocode(receiptId: string): Promise<void> {
  try {
    const row = await getReceipt(receiptId) as any;
    if (!row) return;
    const hit = await geocodeReceipt({ address: row.address, merchant: row.merchant });
    if (!hit) return;
    await updateReceiptGeocode(receiptId, { ...hit, address: row.address });
  } catch {
    // Geocoding failures never affect core pipeline
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────

async function runJob(jobId: string) {
  const job = jobs.get(jobId)!;

  try {
    // Single agent call: Claude reads image + writes to DB directly
    const { sessionId } = await processReceipt(job.imagePath, job.receiptId);

    emit(jobId, { type: "done", data: { receiptId: job.receiptId } });

    // Fire-and-forget: geocode after extraction, persist lat/lng
    runGeocode(job.receiptId);

    // Langfuse: ingest session trace (fire-and-forget)
    ingestSession(getSessionJsonlPath(sessionId), ["single-call", "receipt"]).catch(() => {});
  } catch (err: any) {
    // Check if Claude already wrote the data before the error (e.g. "Reached max turns"
    // but the DB write succeeded in an earlier turn)
    const receipt = await getReceipt(job.receiptId).catch(() => null) as any;
    if (receipt && receipt.status === "done") {
      // Claude finished the DB write — treat as success
      emit(jobId, { type: "done", data: { receiptId: job.receiptId } });
      runGeocode(job.receiptId);
    } else {
      job.error = err.message;
      await updateReceiptStatus(job.receiptId, "error", err.message).catch(() => {});
      emit(jobId, { type: "error", data: { error: err.message } });
    }
  } finally {
    running--;
    drainQueue();
  }
}

function drainQueue() {
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const jobId = queue.shift()!;
    running++;
    runJob(jobId); // fire-and-forget
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Submit a receipt for extraction.
 * Inserts a placeholder row immediately, then queues the agent call.
 * Returns immediately with jobId; results arrive via events.
 */
export async function submitJob(imagePath: string, notes?: string): Promise<Job> {
  const jobId = uuidv4();
  const receiptId = uuidv4();

  // Insert placeholder so receipt appears in GET /receipts immediately
  await insertReceiptPlaceholder(receiptId, imagePath, notes);

  const job: Job = {
    id: jobId,
    receiptId,
    imagePath,
    notes,
    status: "queued",
    createdAt: new Date().toISOString(),
  };

  jobs.set(jobId, job);
  queue.push(jobId);
  emit(jobId, { type: "queued", data: { jobId, receiptId } });
  drainQueue();

  return job;
}
