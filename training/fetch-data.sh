#!/usr/bin/env bash
# Downloads short audio samples for classifier training, converts to 16 kHz mono
# WAV. Audio is used only for local feature extraction — NOT committed to the
# repo (training/audio/ is gitignored). Re-running skips files already present.
#
# Usage:  bash training/fetch-data.sh
set -u
cd "$(dirname "$0")"

OUT=audio
mkdir -p "$OUT"/{snoring,bruxism,other}
SECS=120

dl () {
  local label="$1"; shift
  local n="$1"; shift
  local query="$1"; shift
  echo "── [$label] ($n) $query"
  yt-dlp --no-warnings --no-playlist --ignore-errors \
    --download-archive "$OUT/.archive" \
    --match-filter "duration < 5400" \
    --extractor-args "youtube:player_client=android,tv,web_safari" \
    --retries 8 --fragment-retries 8 \
    -f "bestaudio/best" -x --audio-format wav \
    --postprocessor-args "ffmpeg:-ar 16000 -ac 1 -t ${SECS}" \
    -o "$OUT/$label/%(id)s.%(ext)s" \
    "ytsearch${n}:${query}" 2>&1 | grep -E "Destination|ERROR|has already" | head -12 || true
}

dl snoring 5 "loud snoring sound effect"
dl snoring 4 "snoring sounds for sleeping 1 hour"
dl snoring 4 "real heavy snoring recording"
dl snoring 3 "light snoring asmr"

dl bruxism 5 "teeth grinding sound effect"
dl bruxism 5 "the sound of tooth grinding bruxism"
dl bruxism 4 "teeth grinding asmr"
dl bruxism 4 "bruxism night recording teeth grinding"
dl bruxism 3 "grinding teeth sound close up mic"

dl other 3 "deep breathing sleep no snore"
dl other 3 "box fan white noise 1 hour"
dl other 3 "rain on window sleep sound"
dl other 3 "quiet room tone ambience"
dl other 2 "coughing sound effect"
dl other 2 "sleep talking recording"

echo
for d in snoring bruxism other; do
  printf "  %-9s %s files\n" "$d" "$(ls "$OUT/$d"/*.wav 2>/dev/null | wc -l | tr -d ' ')"
done
