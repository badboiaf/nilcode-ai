#!/usr/bin/env bash
# NULLCODE macOS packaging - mirrors the Windows SEA approach:
#   node binary + SEA blob (postject) becomes the app executable inside
#   NULLCODE.app, plus public/ assets; data dirs are created at first run.
# Usage: bash scripts/mac-bundle.sh [arm64|x64] [--dmg]
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"
WANT_DMG=false
if [ "${2:-}" = "--dmg" ]; then WANT_DMG=true; fi

echo "== bundle server (esbuild) =="
mkdir -p build/mac
npx esbuild server/index.js --bundle --platform=node --format=cjs --target=node20 \
  --outfile=build/nullcode-mac.cjs --external:playwright-core --log-level=warning

echo "== sea blob ="
printf '{ "main": "%s", "output": "%s", "disableExperimentalSEAWarning": true }\n' \
  "$(pwd)/build/nullcode-mac.cjs" "$(pwd)/build/sea-prep-mac.blob" > build/sea-config-mac.json
node --experimental-sea-config build/sea-config-mac.json

echo "== app bundle scaffolding =="
APP=build/mac/NULLCODE.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/MacOS/public/brand"

cp build/icons/nullcode.icns "$APP/Contents/Resources/nullcode.icns"
cp public/brand/*.svg "$APP/Contents/MacOS/public/brand/"
cp public/index.html public/styles.css public/app.js public/auth.js "$APP/Contents/MacOS/public/"
cp build/icons/icon-512.png "$APP/Contents/MacOS/public/brand/"

VERSION=$(node -p "require('./package.json').version")

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>NULLCODE</string>
  <key>CFBundleDisplayName</key>       <string>NULLCODE</string>
  <key>CFBundleIdentifier</key>        <string>online.xeer0.nullcode</string>
  <key>CFBundleVersion</key>           <string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleExecutable</key>        <string>NULLCODE</string>
  <key>LSMinimumSystemVersion</key>    <string>11.0</string>
  <key>LSApplicationCategoryType</key> <string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key>   <true/>
  <key>CFBundleIconFile</key>          <string>nullcode</string>
</dict>
</plist>
PLIST

echo "== mac executable (node + SEA blob) =="
cp "$(command -v node)" "$APP/Contents/MacOS/nullcode-server"
chmod +x "$APP/Contents/MacOS/nullcode-server"
node node_modules/postject/dist/cli.js "$APP/Contents/MacOS/nullcode-server" NODE_SEA_BLOB build/sea-prep-mac.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo "== launcher (double-clickable) ="
cat > "$APP/Contents/MacOS/NULLCODE" <<LAUNCHER
#!/bin/bash
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
exec "\$DIR/nullcode-server"
LAUNCHER
chmod +x "$APP/Contents/MacOS/NULLCODE"

echo "== dist assembly ="
DIST=dist/mac
mkdir -p "$DIST"
rm -rf "$DIST/NULLCODE.app"
cp -R "$APP" "$DIST/"
cat > "$DIST/README.txt" <<README
NULLCODE for macOS - version $VERSION
Double-click NULLCODE.app. Unsigned builds: right-click > Open on first launch.
README

if [ "$WANT_DMG" = true ]; then
  echo "== dmg ="
  rm -f "dist/NULLCODE-macOS-$ARCH.dmg"
  hdiutil create -volname "NULLCODE" -srcfolder "$DIST/NULLCODE.app" -ov -format UDZO "dist/NULLCODE-macOS-$ARCH.dmg"
fi

echo "Done: $DIST/NULLCODE.app"
