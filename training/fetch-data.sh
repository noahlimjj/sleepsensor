#!/usr/bin/env bash
# Downloads short audio samples for classifier training and converts them to
# 16 kHz mono WAV. Audio is used only for local feature extraction — it is NOT
# committed to the repo (training/audio/ is gitignored).
#
# Usage:  bash training/fetch-data.sh
set -u
cd "$(dirname "$0")"

OUT=audio
mkdir -p "$OUT"/{snoring,bruxism,other}

# how many search results to try per query, and how many seconds to keep
N=4
SECS=90

dl () {
  local label="$1"; shift
  local query="$1"; shift
  echo "── [$label] $query"
  yt-dlp --quiet --no-warnings --no-playlist \
    --match-filter "duration < 3600" \
    -f "bestaudio/best" \
    -x --audio-format wav \
    --postprocessor-args "ffmpeg:-ar 16000 -ac 1 -t ${SECS}" \
    -o "$OUT/$label/%(id)s.%(ext)s" \
    "ytsearch${N}:${query}" 2>&1 | grep -E "Destination|Extract|ERROR" || true
}

# --- snoring ---------------------------------------------------------------
dl snoring "loud snoring sound effect"
dl snoring "snoring sounds for sleeping 1 hour"
dl snoring "heavy snoring man recording"
dl snoring "light snoring sound asmr"
dl snoring "snoring sound effect free"

# --- bruxism / teeth grinding -------------------------------------------
dl bruxism "teeth grinding sound bruxism"
dl bruxism "the sound of tooth grinding"
dl bruxism "bruxism sleep recording audio"
dl bruxism "teeth grinding asmr sound"
dl bruxism "night guard teeth grinding noise"

# --- other (so the model doesn't call everything snore/grind) ------------
dl other "person breathing deeply sleep no snoring"
dl other "box fan white noise"
dl other "rain sound sleeping"
dl other "quiet bedroom room tone ambience"
dl other "coughing and clearing throat sound"
dl other "talking in sleep sleeptalking recording"

echo
echo "downloaded:"
for d in snoring bruxism other; do
  printf "  %-9s %s files\n" "$d" "$(ls "$OUT/$d" 2>/dev/null | wc -l | tr -d ' ')"
done
