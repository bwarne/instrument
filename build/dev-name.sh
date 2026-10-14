#!/bin/sh
# `npm run app` runs node_modules' Electron.app, and macOS shows that bundle's name ("Electron") as the
# bold app name in the menu bar; it can't be changed at runtime. Rename the dev bundle to match the
# packaged app. Only touches node_modules; `npm install` may undo it, and the next `npm run app` redoes it.
app="$(dirname "$0")/../node_modules/electron/dist/Electron.app"
plist="$app/Contents/Info.plist"
name=AnInstrument
[ -f "$plist" ] || exit 0
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$plist" 2>/dev/null)" = "$name" ] &&
  codesign --verify "$app" 2>/dev/null && exit 0
for key in CFBundleName CFBundleDisplayName; do
  /usr/libexec/PlistBuddy -c "Set :$key $name" "$plist" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$key string $name" "$plist"
done
# Editing Info.plist breaks the bundle's signature, which Apple Silicon needs to launch it. Re-sign it
# ad hoc ("-"), the same kind of local signature it came with.
codesign --force --deep --sign - "$app" 2>/dev/null
