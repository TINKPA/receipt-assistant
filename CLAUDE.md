# Receipt Assistant — Claude Code Instructions

You are a receipt parsing assistant. Your job is to extract structured data from receipt images.

## Database Schema

The SQLite database is at `/data/receipts.db`. Tables:

### `receipts`
| Column         | Type    | Notes                                                    |
|----------------|---------|----------------------------------------------------------|
| id             | TEXT PK | UUID                                                     |
| merchant       | TEXT    | Store/restaurant name                                    |
| date           | TEXT    | ISO 8601 date: YYYY-MM-DD                                |
| total          | REAL    | Final amount paid                                        |
| currency       | TEXT    | USD, CNY, EUR, JPY, etc.                                 |
| category       | TEXT    | food/groceries/transport/shopping/utilities/entertainment/health/education/travel/other |
| payment_method | TEXT    | credit_card/debit_card/cash/mobile_pay/other             |
| tax            | REAL    | Tax amount                                               |
| tip            | REAL    | Tip amount                                               |
| notes          | TEXT    | User notes                                               |
| raw_text       | TEXT    | Full OCR transcription                                   |
| image_path     | TEXT    | Path to original image                                   |

### `receipt_items`
| Column      | Type    | Notes                          |
|-------------|---------|--------------------------------|
| id          | INTEGER | Auto-increment                 |
| receipt_id  | TEXT FK | References receipts(id)        |
| name        | TEXT    | Item name                      |
| quantity    | REAL    | Default 1                      |
| unit_price  | REAL    | Price per unit                  |
| total_price | REAL    | Quantity × unit_price           |
| category    | TEXT    | Optional item-level category   |

## Rules

1. **Date format**: Always YYYY-MM-DD. If year is missing, use current year.
2. **Total**: Use the FINAL total (after tax, after tip). If subtotal and total both exist, use total.
3. **Currency detection**: $ → USD, ¥ → detect context (CNY vs JPY), € → EUR, £ → GBP.
4. **Category**: Pick the single most appropriate category from the allowed values.
5. **Don't guess**: If a field is not visible on the receipt, omit it. Don't fabricate data.
6. **Line items**: Extract as many as you can read. Include quantity and price when visible.
7. **Language**: Receipts may be in English, Chinese, or other languages. Handle all.
8. **raw_text**: Transcribe the full receipt text as-is for future reference.

## Known Pitfalls

1. **`--json-schema` degrades OCR accuracy vs plain text output**:
   Tested 10 receipts with Sonnet, same prompt, same model:
   - `--json-schema` mode: 4/10 dates wrong (including year errors,
     fallbacks to today's date, merchant names unreadable)
   - Plain text mode: all 4 disagreements were more accurate
   
   Notable case: AYCE Sushi receipt — JSON-schema couldn't read the
   merchant name at all ("Unknown"), text mode read "GYOTAKU".
   JSON-schema fell back to today's date, text mode got 2026-03-06.
   
   Root cause: `--json-schema` forces direct JSON output with no
   reasoning space. Text mode allows chain-of-thought ("is this a 3
   or a 9? Given the date context...") which improves ambiguous OCR.
   
   **Solution**: Two-step pipeline — Step 1: text OCR + reasoning,
   Step 2: structure the text into JSON.
   
   Additional finding: Phase 1 errors can anchor-bias Phase 2 OCR.
   Mitigation: prompt marks Phase 1 date as "UNVERIFIED" to reduce
   anchoring effect. Costco gas receipt remains a hard case — the
   date digits are genuinely ambiguous in this photo angle.

2. **Handwritten amounts**: Tips and totals written by hand are
   frequently missed or misread. The `handwritten_tip` warning flag
   helps surface this, but accuracy is model-dependent.

3. **Confidence self-assessment is unreliable**: Opus gave 0.88
   confidence on a result where it missed the date entirely.
   Don't use confidence_score as sole quality gate.

## Image Reading

To read a receipt image, use the Bash tool:
```bash
# View the image (Claude can read image files directly)
cat /path/to/receipt.jpg
```

Or use the Read tool to inspect the file.

## Langfuse Observability

Self-hosted Langfuse runs alongside the app for LLM monitoring.
All `claude -p` calls auto-ingest session traces via `src/langfuse.ts`.

### Querying Langfuse via API

**Always use the Langfuse REST API for programmatic access** — don't
navigate the web UI manually when you need to inspect traces, compare
outputs, or verify data.

```bash
# List recent traces (with input/output)
curl -s http://$LANGFUSE_HOST/api/public/traces \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"

# Get a specific trace by ID
curl -s http://$LANGFUSE_HOST/api/public/traces/<trace-id> \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"

# Get observations (generations) for a trace
curl -s "http://$LANGFUSE_HOST/api/public/observations?traceId=<trace-id>" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY"
```

Local dev defaults:
- Host: `http://localhost:3333`
- Public key: `pk-receipt-local`
- Secret key: `sk-receipt-local`

### Manual Verification Flow

No verify script. Three curl calls are the contract:

```bash
# 1. Upload
JOB=$(curl -sS -X POST http://localhost:3000/receipt \
  -F "image=@$HOME/Desktop/RECEIPT/IMG.jpeg" | jq -r .jobId)

# 2. Poll until status=done
while :; do
  s=$(curl -sS http://localhost:3000/jobs/$JOB | jq -r .status)
  [[ "$s" == "done" || "$s" == "error" ]] && break
  sleep 2
done
RECEIPT=$(curl -sS http://localhost:3000/jobs/$JOB | jq -r .receiptId)

# 3. Inspect the receipt record (the data of record — merchant/date/
#    total/tip/items are all here)
curl -sS http://localhost:3000/receipt/$RECEIPT | jq .
```

For the Langfuse trace, query the API directly (see
"Query Langfuse" above). Never trust a wrapper script's display —
go to `/receipt/:id` for ground truth. (Earlier `verify-receipt.sh`
printed all-None while the DB had correct data; deleted to avoid
that trap.)

### Why API over UI

- **Scriptable**: can diff outputs, run assertions, batch-verify
- **Cross-reference**: compare Langfuse trace output with app API
  result in a single command pipeline
- **CI-ready**: verification scripts can hit the API directly
- **No context switching**: stay in terminal, no browser navigation
