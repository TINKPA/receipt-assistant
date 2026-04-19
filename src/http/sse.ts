/**
 * Server-Sent Events helpers.
 *
 * SSE is a text/event-stream over a long-lived HTTP GET. The wire format
 * is plain ASCII:
 *
 *   event: name\n
 *   data: <payload>\n
 *   \n
 *
 * Multi-line data payloads must repeat `data: ` per line; we always
 * JSON-stringify so the payload is a single line and the multi-line
 * branch is unused. Empty lines separate frames.
 *
 * Nginx and some corporate proxies will buffer the response by default,
 * which breaks SSE's real-time semantics. `X-Accel-Buffering: no`
 * disables buffering on Nginx; `Cache-Control: no-cache` and
 * `Connection: keep-alive` are the other half of the incantation.
 *
 * `keepalive(res)` emits an SSE comment every 15s. Comments start with
 * `:` and are ignored by clients — they exist solely to keep proxies
 * from closing "idle" connections after 30-60s of silence.
 */
import type { Response } from "express";

/**
 * Write SSE response headers. Must be called before any `sendEvent`.
 *
 * We also call `flushHeaders()` so the client actually receives the
 * 200 before any events arrive — otherwise buffered servers will hold
 * the entire response until the stream ends.
 */
export function setSseHeaders(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // Flush headers immediately so the client sees the 200 status before
  // the first event arrives. Without this, tests that `await fetch(...)`
  // would block on the initial promise until an event is sent.
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

/**
 * Write one SSE frame. `data` is JSON-stringified; the resulting line
 * contains no newlines because JSON.stringify doesn't emit raw LFs.
 */
export function sendEvent(
  res: Response,
  name: string,
  data: unknown,
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(data);
  res.write(`event: ${name}\ndata: ${payload}\n\n`);
}

/**
 * Kick off a 15s keepalive ticker. Returns the interval handle so the
 * caller can `clearInterval` it in the `req.on('close', ...)` handler.
 *
 * The "event" written is an SSE *comment* (leading `:`) — clients
 * silently drop it, but proxies see bytes on the wire and keep the
 * connection open.
 */
export function keepalive(res: Response): NodeJS.Timeout {
  const handle = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(handle);
      return;
    }
    res.write(`: keepalive\n\n`);
  }, 15_000);
  // Don't prevent process exit on this timer; SSE connections are
  // inherently long-lived but we don't want them holding the event
  // loop open during graceful shutdown.
  if (typeof handle.unref === "function") {
    handle.unref();
  }
  return handle;
}
