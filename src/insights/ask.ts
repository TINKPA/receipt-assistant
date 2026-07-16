/**
 * Natural-language Q&A over the ledger (v2 redesign P5, #149; board
 * screen 19). Spawns the same `claude -p` worker the extractor uses,
 * but READ-ONLY: the prompt exposes psql for SELECTs and the answer
 * comes back as text. Single-user deployment; the endpoint is
 * synchronous with a generous timeout and the UI shows a thinking
 * state.
 *
 * Safety: SELECT-only is enforced by instruction plus a default
 * transaction_read_only session — the agent's psql alias starts every
 * connection with `options=-c default_transaction_read_only=on`, so a
 * stray UPDATE fails at the server even if the instruction is ignored.
 */
import { runClaude, detectPsqlCommand } from "../claude.js";

const SCHEMA_DIGEST = `
LEDGER SCHEMA (PostgreSQL; amounts in MINOR units — divide by 100 for dollars):
- transactions(id, workspace_id, occurred_on DATE, payee, narration, status[draft|posted|reconciled|error], deleted_at TIMESTAMPTZ NULL, merchant_id, place_id, metadata)
- postings(id, transaction_id, account_id, amount_minor, amount_base_minor, currency) — double-entry; expense side is POSITIVE amount_base_minor
- accounts(id, name, type[asset|liability|equity|income|expense]) — expense account name IS the spending category (e.g. 'Food & Drinks','Services','Travel','Transportation','Entertainment','Shopping','Groceries')
- transaction_items(id, transaction_id, product_id, description, quantity, unit_price_minor, line_total_minor, effective_total_minor[incl. tax/tip share])
- products(id, canonical_name, custom_name, item_class[durable|consumable|food_drink|service|other], purchase_count, total_spent_minor)
- merchants(id, canonical_name, brand_id) / brands(brand_id TEXT PK, name) / places(id, formatted_address, locality)
- owned_items(id, product_id, transaction_item_id, acquired_on, condition, retired_at, target_days)
- wish_items(id, title, target_price_minor, planned_days, urgency, status)
- documents(id, kind, ocr_text) + document_links(document_id, transaction_id)
CONVENTIONS: spending total for a period = SUM(p.amount_base_minor) joined to expense accounts with amount_base_minor > 0 and t.status IN ('posted','reconciled') AND t.deleted_at IS NULL. Dates are local; occurred_on is the receipt date.`;

export async function askLedger(
  workspaceId: string,
  question: string,
): Promise<{ answer: string; sessionId: string }> {
  const basePsql = await detectPsqlCommand();

  const prompt = `You are the analytical brain of a personal receipt ledger. Answer the user's question by querying PostgreSQL, then reply in a tight editorial voice.

${SCHEMA_DIGEST}

DATABASE — run read-only SQL via:
${basePsql} "SET default_transaction_read_only=on; <YOUR SELECT>"

WORKSPACE: every query MUST filter workspace_id = '${workspaceId}' on tables that have it.

RULES:
- SELECT only. Never INSERT/UPDATE/DELETE/DDL — the session is read-only and writes will error.
- Run as many queries as you need (typically 1-3). Check your numbers.
- ANSWER FORMAT (plain text, no markdown headers):
  Line 1: the single most important figure, like "$418.72" or "14 visits", followed by one clause of context.
  Then 2-5 short lines of supporting breakdown ("Blue Bottle — $95.90 across 14 visits").
  Optionally one closing observation sentence.
- If the data genuinely can't answer the question, say exactly what's missing. Never fabricate numbers.

QUESTION: ${question}`;

  const args = [
    "-p",
    prompt,
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--model",
    process.env.CLAUDE_MODEL || "sonnet",
  ];
  const { stdout, sessionId } = await runClaude(args, 180_000);
  return { answer: stdout.trim(), sessionId };
}
