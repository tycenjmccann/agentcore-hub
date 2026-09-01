#!/usr/bin/env bash
# Generates per-act voiceover MP3s using Amazon Polly generative engine.
# Voice: Brian (en-GB, generative) — chosen for expressive narration.
set -euo pipefail
cd "$(dirname "$0")"

VOICE="${POLLY_VOICE:-Brian}"
ENGINE="generative"
REGION="${AWS_REGION:-us-east-1}"

for f in scripts/*.txt; do
  base=$(basename "$f" .txt)
  out="audio/${base}.mp3"
  echo "→ $base ($VOICE / $ENGINE)"
  aws polly synthesize-speech \
    --region "$REGION" \
    --engine "$ENGINE" \
    --voice-id "$VOICE" \
    --output-format mp3 \
    --text-type text \
    --text "file://$f" \
    "$out" >/dev/null
done
echo ""
echo "Done. MP3s in $(pwd)/audio/"
ls -lh audio/
