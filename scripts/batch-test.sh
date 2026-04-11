#!/usr/bin/env bash
# batch-test.sh — Upload N receipts and collect results for comparison
set -uo pipefail

APP="${APP_HOST:-http://localhost:3000}"
DIR="${1:-$HOME/Desktop/RECEIPT}"
LIMIT="${2:-10}"

echo "| # | File | Merchant | Date | Total | Category | Confidence | Warnings |"
echo "|---|------|----------|------|-------|----------|------------|----------|"

i=0
for img in $(find "$DIR" -maxdepth 1 -type f \( -iname '*.jpeg' -o -iname '*.jpg' -o -iname '*.png' \) | sort | head -"$LIMIT"); do
  i=$((i+1))

  fname=$(basename "$img")

  # Upload
  job_id=$(curl -s -X POST "$APP/receipt" -F "image=@$img" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['jobId'])" 2>/dev/null)

  if [ -z "$job_id" ]; then
    echo "| $i | $fname | UPLOAD FAILED | | | | | |"
    continue
  fi

  # Poll
  for attempt in $(seq 1 60); do
    result=$(curl -s "$APP/jobs/$job_id")
    job_status=$(echo "$result" | python3 -c "import json,sys; print(json.loads(sys.stdin.read(),strict=False)['status'])" 2>/dev/null)
    [ "$job_status" = "done" ] || [ "$job_status" = "error" ] && break
    sleep 3
  done

  if [ "$job_status" = "error" ]; then
    echo "| $i | $fname | ERROR | | | | | |"
    continue
  fi

  # Extract fields
  echo "$result" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read(), strict=False)
r = d.get('fullResult', {})
meta = r.get('extraction_meta', {})
quality = meta.get('quality', {})
conf = quality.get('confidence_score', '')
warnings = ', '.join(quality.get('warnings', []))
print(f\"| $i | $fname | {r.get('merchant','')} | {r.get('date','')} | {r.get('total','')} {r.get('currency','')} | {r.get('category','')} | {conf} | {warnings} |\")
" 2>/dev/null

done

echo ""
echo "Total: $i receipts processed"
