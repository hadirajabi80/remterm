#!/usr/bin/env bash
# Builds Remterm.app (universal: Apple Silicon + Intel) and Remterm-<version>-macOS.dmg.
# Runs on macOS with Go, Node and the Xcode command line tools (CI: .github/workflows/build.yml).
#   ./build-macos.sh 1.1.0
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:-dev}"
OUT=build/macos
APP="$OUT/Remterm.app"
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ ! -f frontend/dist/index.html ]; then
  (cd frontend && npm ci && npm run build)
fi

export CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=11.0
for arch in arm64 amd64; do
  carch=$([ "$arch" = amd64 ] && echo x86_64 || echo arm64)
  GOOS=darwin GOARCH=$arch CC="clang -arch $carch" CGO_CFLAGS="-arch $carch" CGO_LDFLAGS="-arch $carch" \
    go build -tags desktop,production -trimpath -ldflags "-s -w" -o "$OUT/remterm-$arch" .
done
lipo -create -output "$APP/Contents/MacOS/Remterm" "$OUT/remterm-arm64" "$OUT/remterm-amd64"
rm "$OUT/remterm-arm64" "$OUT/remterm-amd64"

# App icon from the same drawing as the Windows icon.
ICONSET="$OUT/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/appicon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/appicon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
rm -rf "$ICONSET"

cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Remterm</string>
  <key>CFBundleDisplayName</key><string>Remterm</string>
  <key>CFBundleExecutable</key><string>Remterm</string>
  <key>CFBundleIdentifier</key><string>com.remterm.app</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Remterm</string>
  <!-- Folders dropped on the Dock icon / sent by "Open in Remterm" open a terminal there. -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Folder</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    </dict>
  </array>
</dict>
</plist>
EOF

# Ad-hoc signature (not notarized): Apple Silicon requires a signature to run at all.
codesign --force --deep --sign - "$APP"

STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Remterm" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Remterm-${VERSION}-macOS.dmg" >/dev/null
rm -rf "$STAGE"
echo "Built $OUT/Remterm-${VERSION}-macOS.dmg"
