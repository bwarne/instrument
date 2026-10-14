#!/bin/sh
# Publishes the build from `npm run release` as a GitHub release: the .dmg for new installs, plus the
# .zip, its .blockmap and latest-mac.yml, which installed copies read to update themselves.
# Usage: npm run publish -- "release notes"
# Uploads to GitHub sometimes time out (HTTP 408), so each file is retried until its size matches,
# and the release stays a draft (invisible to the updater) until every file is there.
set -eu
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
NOTES=${1:-"AnInstrument $VERSION"}
FILES="dist/AnInstrument-arm64.dmg dist/AnInstrument-arm64-mac.zip dist/AnInstrument-arm64-mac.zip.blockmap dist/latest-mac.yml"

for f in $FILES; do [ -f "$f" ] || { echo "missing $f: run npm run release first"; exit 1; }; done
grep -q "^version: $VERSION$" dist/latest-mac.yml || { echo "dist/latest-mac.yml isn't for $VERSION: run npm run release again"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes: commit first, so the release matches its tag"; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "HEAD isn't pushed: git push first"; exit 1; }
if gh release view "$TAG" --json isDraft -q .isDraft 2>/dev/null | grep -q false; then
  echo "$TAG is already published"; exit 1
fi

gh release view "$TAG" >/dev/null 2>&1 \
  || gh release create "$TAG" --draft --target "$(git rev-parse HEAD)" --title "AnInstrument $VERSION" --notes "$NOTES"

for f in $FILES; do
  name=$(basename "$f"); want=$(stat -f%z "$f")
  size() { gh release view "$TAG" --json assets -q ".assets[] | select(.name==\"$name\") | .size"; }
  have=$(size)
  for try in 1 2 3 4 5; do
    [ "$have" = "$want" ] && break
    echo "uploading $name (try $try)"
    gh release upload "$TAG" "$f" --clobber || sleep 5
    have=$(size)
  done
  [ "$have" = "$want" ] || { echo "couldn't upload $name; run npm run publish again to retry"; exit 1; }
  echo "uploaded $name ($want bytes)"
done

gh release edit "$TAG" --draft=false --latest >/dev/null
gh release view "$TAG" --json url -q .url
