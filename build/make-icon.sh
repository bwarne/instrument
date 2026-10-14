#!/bin/sh
# Renders build/icon.svg to build/icon.png (1024px, transparent corners), which electron-builder turns
# into the app's .icns. Needs ImageMagick (brew install imagemagick); Quick Look does the SVG rendering.
# Quick Look flattens onto white, so render on the tile colour and cut the rounded tile out with a mask.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
sed -e 's|<g clip-path="url(#tile)">|<rect width="1024" height="1024" fill="#111"/><g>|' icon.svg > "$tmp/full.svg"
qlmanage -t -s 1024 -o "$tmp" "$tmp/full.svg" >/dev/null 2>&1
magick -size 1024x1024 xc:black -fill white -draw "roundrectangle 100,100 923,923 185,185" "$tmp/mask.png"
magick "$tmp/full.svg.png" "$tmp/mask.png" -alpha off -compose CopyOpacity -composite icon.png
rm -r "$tmp"
echo "wrote build/icon.png"
