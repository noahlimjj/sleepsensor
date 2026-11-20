#!/usr/bin/env bash
# Downloads PSG-Audio patients (Korompili et al. 2021, Science Data Bank
# doi:10.11922/sciencedb.00345), keeps only the ambient-microphone channel as
# 16 kHz mono FLAC and deletes the EDFs. Nothing here is committed to the repo.
#   PAR=2 SEGS='002|003' bash fetch-patient.sh 00001006-100507 [more ids...]
# The host allows about two connections at once; more return 504s.
set -u
ROOT="${PSG_AUDIO_DIR:-$HOME/datasets/psg-audio}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export ROOT HERE
mkdir -p "$ROOT/edf"
[ -s "$ROOT/allurl.txt" ] || curl -sL -A "Mozilla/5.0" "https://www.scidb.cn/api/gin-sdb-filetree/getAllUrl?dataSetId=778740145531650048&version=V3" -o "$ROOT/allurl.txt"

one() {
  url="$1"
  ID=$(echo "$url" | sed -E 's#.*/APNEA_EDF/([^/]+)/.*#\1#')
  seg=$(echo "$url" | sed -E 's/.*%5B([0-9]+)%5D\.edf$/\1/')
  mkdir -p "$ROOT/audio/$ID"
  out="$ROOT/audio/$ID/$seg.flac"
  [ -s "$out" ] && return 0
  edf="$ROOT/edf/$ID-$seg.edf"
  got=0
  for try in 1 2 3 4 5 6 7 8 9 10 11 12; do
    curl -fsL -A "Mozilla/5.0" -C - --connect-timeout 60 --speed-limit 2000 --speed-time 180 "$url" -o "$edf" && { got=1; break; }
    sleep 5
  done
  [ "$got" = 1 ] || { echo "$ID $seg FAILED"; return 0; }
  head -c 8 "$edf" | grep -q "^0 " || { echo "$ID $seg BAD FILE"; rm -f "$edf"; return 0; }
  node "$HERE/edf-mic.mjs" "$edf" Mic 2>/dev/null | ffmpeg -loglevel error -y -f s16le -ar 48000 -ac 1 -i - -ar 16000 "$out.tmp.flac" \
    && [ "$(stat -f%z "$out.tmp.flac")" -gt 1000000 ] && mv "$out.tmp.flac" "$out" && rm -f "$edf"
  echo "$(date +%H:%M) $ID $seg done"
}
export -f one
for ID in "$@"; do grep "/V3/APNEA_EDF/$ID/" "$ROOT/allurl.txt"; done | sed 's/\[/%5B/g; s/\]/%5D/g' | grep -E "%5B(${SEGS:-[0-9]+})%5D" \
  | xargs -P "${PAR:-3}" -I{} bash -c 'one "{}"'
