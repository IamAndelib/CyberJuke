#!/usr/bin/env bash
# Regenerates the repository's media from the app itself (npm run media):
#   media/screenshots/*.png         README highlights, one per part of the app
#   media/themes/<theme>.png        Home in each theme, and media/themes/themes.png (all 8)
#   media/brand/social-preview.png  1280x640 card for GitHub's social preview
# The shots come from tests/screenshots/media.spec.ts: the app's own web build, at phone
# size, with the test fixture's synthetic Jukebox (no real posts or people).
# Needs ImageMagick (convert, montage) and the Playwright browser (npx playwright install chromium).
set -euo pipefail
cd "$(dirname "$0")/.."

for tool in convert montage; do
  command -v "$tool" >/dev/null || { echo "ImageMagick's $tool is missing (e.g. sudo apt install imagemagick)." >&2; exit 1; }
done
FONT=$(fc-match -f '%{file}' 'DejaVu Sans Mono:bold' 2>/dev/null || true)
[[ -f "$FONT" ]] || FONT=DejaVu-Sans-Mono-Bold

npx playwright test --project=screenshots tests/screenshots/media.spec.ts
SHOTS=test-results/screenshots

# A palette PNG (256 colours, no dithering: the themes have few colours) at a given width.
PNG8=(-strip +dither -colors 256 -define png:compression-level=9)
shrink() { convert "$1" -resize "$3x" "${PNG8[@]}" "PNG8:$2"; }

# ---- README highlights --------------------------------------------------------------------
mkdir -p media/screenshots media/themes
rm -f media/screenshots/*.png
declare -A NAMES=(
  [01-home]=home [02-now-playing]=now-playing [03-up-next]=up-next [04-lyrics]=lyrics
  [05-artist]=artist [06-genre]=genre [07-search]=search [08-here-genres]=here-search
  [09-library]=library
)
for k in "${!NAMES[@]}"; do
  shrink "$SHOTS/media-$k.png" "media/screenshots/${NAMES[$k]}.png" 540
done

# ---- Theme gallery --------------------------------------------------------------------------
THEMES=(dark light c64 vt320 matrix crypt bubblegum brutalist)
LABELS=(Dark Light C64 VT320 Matrix Crypt Bubblegum Brutalist)
args=()
for i in "${!THEMES[@]}"; do
  t=${THEMES[$i]}
  shrink "$SHOTS/media-theme-$t.png" "media/themes/$t.png" 360
  args+=(-label "${LABELS[$i]}" "media/themes/$t.png")
done
montage -font "$FONT" -pointsize 20 -fill '#efe5c0' -background '#000000' \
  "${args[@]}" -tile 4x2 -geometry 270x+14+14 miff:- | convert - "${PNG8[@]}" "PNG8:media/themes/themes.png"

# ---- Social preview card --------------------------------------------------------------------
# Left: the banner's jukebox and wordmark; right: three phone screens; the checkered rule
# along the bottom, as on the banner.
B=media/brand/banner.png
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
convert "$B" -crop 330x380+148+102 +repage -resize 188x "$tmp/jukebox.png"
convert "$B" -crop 690x250+560+195 +repage -resize 470x "$tmp/wordmark.png"
convert "$B" -crop 1280x40+0+600 +repage "$tmp/rule.png"
for n in home now-playing up-next; do
  convert "$SHOTS/media-$( for k in "${!NAMES[@]}"; do [[ ${NAMES[$k]} == "$n" ]] && echo "$k"; done ).png" \
    -resize x500 -bordercolor '#3a3a3a' -border 3 "$tmp/$n.png"
done
convert -size 1280x640 xc:'#000000' \
  "$tmp/jukebox.png" -geometry +112+92 -composite \
  "$tmp/wordmark.png" -geometry +70+330 -composite \
  "$tmp/home.png" -geometry +566+40 -composite \
  "$tmp/now-playing.png" -geometry +805+40 -composite \
  "$tmp/up-next.png" -geometry +1044+40 -composite \
  "$tmp/rule.png" -geometry +0+600 -composite \
  "${PNG8[@]}" PNG8:media/brand/social-preview.png

echo "Media written:"
find media/screenshots media/themes media/brand/social-preview.png -name '*.png' -printf '  %8s  %p\n' | sort -k2
