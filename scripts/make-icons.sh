#!/usr/bin/env bash
# Rebuild the PNG app icons in public/ from public/icon.svg. Needs ImageMagick 7.
#   pwa-192.png, pwa-512.png   manifest icons (purpose "any"), rounded, transparent corners
#   pwa-512-maskable.png       Android adaptive icon: full-bleed, artwork inside the 80% safe zone
#   apple-touch-icon.png       iOS home screen: 180px, opaque, square (iOS rounds it)
set -euo pipefail
cd "$(dirname "$0")/../public"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MASKABLE="$TMP/maskable.svg"
cat > "$MASKABLE" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0f0f0f"/>
  <g transform="translate(256 256) scale(0.8) translate(-256 -275)">
    <rect x="96" y="120" width="320" height="210" rx="28" fill="#ff4d4d"/>
    <path d="M232 188l92 54-92 54z" fill="#ffffff"/>
    <rect x="96" y="356" width="320" height="26" rx="13" fill="#3a3a3a"/>
    <rect x="96" y="404" width="220" height="26" rx="13" fill="#2a2a2a"/>
  </g>
</svg>
SVG

for n in 192 512; do
  magick -background none -density 384 icon.svg -resize "${n}x${n}" "pwa-$n.png"
done
magick -density 384 "$MASKABLE" -resize 512x512 pwa-512-maskable.png
magick -density 384 "$MASKABLE" -resize 180x180 -background '#0f0f0f' -flatten apple-touch-icon.png
echo "Icons written to public/"
