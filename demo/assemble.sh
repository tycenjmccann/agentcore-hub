#!/usr/bin/env bash
# Mux per-act .webm video with the matching .mp3 voiceover into final per-act
# .mp4 files, then concat into demo/master.mp4.
#
# Strategy:
#   - Each test() in record.spec.ts is timed to roughly match its VO. The audio
#     track is the source of truth for length — we extend video to audio length
#     by holding the last frame (tpad=stop_mode=clone), then trim to audio
#     length so cut-points align cleanly between acts.
#   - One mp4 per act keeps re-shoots cheap: redo a bad act, re-run concat.
#
# Requires: ffmpeg in PATH.
set -euo pipefail
cd "$(dirname "$0")"

RAW="video/raw"
FINAL="video/final"
AUDIO="audio"
mkdir -p "$FINAL"

# Acts in order. Must match script basenames in scripts/ and audio/.
ACTS=(
  "01-cold-open"
  "02-dashboard"
  "03-agents-list"
  "04-agent-detail"
  "05-build"
  "06-evaluations"
  "07a-workflow-intro"
  "07b-workflow-bug"
  "07c-workflow-feature"
  "08-ticket-history"
  "09-outro"
)

# Find the .webm Playwright wrote for a given test name. Playwright nests it
# under outputDir/<test-file>-<test-name>-<project>/video.webm.
find_webm() {
  local act="$1"
  find "$RAW" -type f -name "*.webm" -path "*${act}*" -print -quit
}

for act in "${ACTS[@]}"; do
  vid=$(find_webm "$act" || true)
  aud="$AUDIO/${act}.mp3"
  out="$FINAL/${act}.mp4"

  if [[ -z "${vid:-}" || ! -f "$vid" ]]; then
    echo "⚠ skip $act — no video found under $RAW"
    continue
  fi
  if [[ ! -f "$aud" ]]; then
    echo "⚠ skip $act — no audio at $aud"
    continue
  fi

  # Audio duration is canonical.
  adur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$aud")

  echo "→ $act  (audio=${adur}s, video=$vid)"
  ffmpeg -y -loglevel error \
    -i "$vid" -i "$aud" \
    -filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=600,trim=duration=${adur},setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos[v]" \
    -map "[v]" -map 1:a \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k -ar 48000 \
    -shortest \
    "$out"
done

# Concat list (only acts that produced an mp4).
list="$FINAL/.concat.txt"
: > "$list"
for act in "${ACTS[@]}"; do
  f="$FINAL/${act}.mp4"
  [[ -f "$f" ]] && echo "file '${act}.mp4'" >> "$list"
done

echo ""
echo "→ stitching master.mp4"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -c copy master.mp4
echo ""
echo "Done."
ls -lh master.mp4 "$FINAL"/*.mp4
