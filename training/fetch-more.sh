#!/usr/bin/env bash
# Round 2 data collection: more snoring, more grinding, and realistic overnight
# "noise" (fan / AC / traffic / rain / movement / sleep-talking / pets / clock).
# Also pulls ESC-50 snoring clips. Audio is gitignored; used only for training.
set -u
cd "$(dirname "$0")"
OUT=audio
mkdir -p "$OUT"/{snoring,bruxism,other}
SECS=150

dl () {
  local label="$1"; shift; local n="$1"; shift; local q="$1"; shift
  echo "── [$label] ($n) $q"
  yt-dlp --no-warnings --no-playlist --ignore-errors \
    --download-archive "$OUT/.archive" --match-filter "duration < 5400" \
    --extractor-args "youtube:player_client=android,tv,web_safari" \
    --retries 8 -f "bestaudio/best" -x --audio-format wav \
    --postprocessor-args "ffmpeg:-ar 16000 -ac 1 -t ${SECS}" \
    -o "$OUT/$label/%(id)s.%(ext)s" "ytsearch${n}:${q}" 2>&1 | grep -E "Destination|ERROR|has already" | head -10 || true
}

# --- snoring (need more real recordings) ---
dl snoring 6 "real snoring recording sleep study"
dl snoring 6 "snoring sound 8 hours"
dl snoring 5 "loud snoring man sleeping recording"
dl snoring 5 "woman snoring sound"
dl snoring 4 "nasal snoring vs mouth snoring sound"
dl snoring 4 "snoring through nose sound effect"

# --- bruxism / teeth grinding (the weak class) ---
dl bruxism 6 "real teeth grinding sleep recording bruxism"
dl bruxism 6 "teeth grinding sound at night"
dl bruxism 5 "bruxism grinding audio example"
dl bruxism 5 "teeth clenching grinding sound asmr"
dl bruxism 4 "what does teeth grinding sound like"
dl bruxism 4 "sleep bruxism sound recording microphone"
dl bruxism 3 "jaw clenching grinding noise close mic"

# --- realistic overnight noise ---
dl other 3 "bedroom fan noise all night"
dl other 3 "air conditioner white noise sleep"
dl other 3 "distant traffic night ambience bedroom"
dl other 3 "rain thunderstorm sleep sounds"
dl other 3 "person tossing turning in bed sheets rustling"
dl other 2 "sleep talking real recording"
dl other 2 "dog barking distant night"
dl other 2 "wall clock ticking loud"
dl other 2 "coughing sneezing sound effects"
dl other 2 "refrigerator hum kitchen ambience"
dl other 2 "cat meowing purring night"
dl other 2 "footsteps house creaking night"

# --- ESC-50 snoring (target 28) via raw github ---
echo "── ESC-50 snoring"
mkdir -p "$OUT/snoring/esc50"
curl -sL "https://raw.githubusercontent.com/karolpiczak/ESC-50/master/meta/esc50.csv" -o /tmp/esc50.csv
grep ',snoring' /tmp/esc50.csv | cut -d, -f1 | while read -r f; do
  [ -f "$OUT/snoring/esc50/$f" ] && continue
  curl -sL "https://raw.githubusercontent.com/karolpiczak/ESC-50/master/audio/$f" -o "/tmp/$f" && \
  ffmpeg -y -loglevel error -i "/tmp/$f" -ar 16000 -ac 1 "$OUT/snoring/esc50/${f%.wav}.wav" && rm -f "/tmp/$f"
done
echo "  esc50 snoring: $(ls "$OUT/snoring/esc50" 2>/dev/null | wc -l | tr -d ' ')"

echo
for d in snoring bruxism other; do
  printf "  %-9s %s files\n" "$d" "$(find "$OUT/$d" -name '*.wav' | wc -l | tr -d ' ')"
done
