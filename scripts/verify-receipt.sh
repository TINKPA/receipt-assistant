#!/usr/bin/env bash
# verify-receipt.sh — End-to-end receipt verification with Langfuse trace comparison
#
# Usage:
#   ./scripts/verify-receipt.sh <image_path>
#   ./scripts/verify-receipt.sh ~/Desktop/RECEIPT/IMG_0211.jpeg
#
# What it does:
#   1. Upload receipt to app API
#   2. Poll until parsing completes
#   3. Print structured result from app
#   4. Query Langfuse API for the corresponding trace
#   5. Show Claude's reasoning (useful for debugging extraction quality)
#
# Env vars (defaults for local dev):
#   APP_HOST          (default: http://localhost:3000)
#   LANGFUSE_HOST     (default: http://localhost:3333)
#   LANGFUSE_PK       (default: pk-receipt-local)
#   LANGFUSE_SK       (default: sk-receipt-local)

set -euo pipefail

IMAGE="${1:?Usage: $0 <image_path>}"
APP="${APP_HOST:-http://localhost:3000}"
LF="${LANGFUSE_HOST:-http://localhost:3333}"
LF_PK="${LANGFUSE_PK:-pk-receipt-local}"
LF_SK="${LANGFUSE_SK:-sk-receipt-local}"

echo "=== 1. Upload receipt ==="
echo "  Image: $IMAGE"
JOB_ID=$(curl -s -X POST "$APP/receipt" -F "image=@$IMAGE" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['jobId'])")
echo "  Job:   $JOB_ID"

echo -e "\n=== 2. Wait for completion ==="
while true; do
  job_status=$(curl -s "$APP/jobs/$JOB_ID" \
    | python3 -c "import json,sys; print(json.loads(sys.stdin.read(),strict=False)['status'])" 2>/dev/null)
  echo -n "."
  [ "$job_status" = "done" ] || [ "$job_status" = "error" ] && break
  sleep 3
done
echo " $job_status"

if [ "$job_status" = "error" ]; then
  echo "ERROR:"
  curl -s "$APP/jobs/$JOB_ID" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read(), strict=False)
print(d.get('error', 'unknown'))
"
  exit 1
fi

echo -e "\n=== 3. App API Result ==="
curl -s "$APP/jobs/$JOB_ID" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read(), strict=False)
r = d.get('fullResult', {})
print(f\"  Merchant:  {r.get('merchant')}\")
print(f\"  Date:      {r.get('date')}\")
print(f\"  Total:     {r.get('total')} {r.get('currency')}\")
print(f\"  Tax:       {r.get('tax')}\")
print(f\"  Tip:       {r.get('tip')}\")
print(f\"  Category:  {r.get('category')}\")
print(f\"  Payment:   {r.get('payment_method')}\")
print(f\"  Items:     {len(r.get('items',[]))}\")
for i in r.get('items',[]):
    qty = f\"x{i['quantity']} \" if i.get('quantity') and i['quantity'] != 1 else ''
    price = f\"\${i['total_price']}\" if i.get('total_price') else ''
    print(f\"    - {i['name']} {qty}{price}\")
"

echo -e "\n=== 4. Langfuse Traces (via API) ==="
sleep 1  # let ingestion complete
curl -s "$LF/api/public/traces?limit=2&orderBy=timestamp.desc" \
  -u "$LF_PK:$LF_SK" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read(), strict=False)
for t in data.get('data', [])[:2]:
    meta = t.get('metadata', {})
    tokens_in = meta.get('total_input_tokens', 0)
    tokens_out = meta.get('total_output_tokens', 0)
    print(f\"  [{t['name']}]\")
    print(f\"    Model:   {meta.get('model')}\")
    print(f\"    Tokens:  {tokens_in:,} in + {tokens_out:,} out\")
    out = str(t.get('output', '') or '')
    # Show first 300 chars of Claude's reasoning
    if out:
        print(f\"    Output:  {out[0:300]}\")
    print()
"
