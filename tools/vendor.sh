#!/usr/bin/env bash
# Rebuilds the vendored third-party libraries in vendor/.
# Usage: tools/vendor.sh   (needs npm; run from the repo root)
set -euo pipefail
THREE_VERSION=0.186.1
CLIPPER_VERSION=6.4.2
OCCT_VERSION=0.0.23
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund "three@$THREE_VERSION" "clipper-lib@$CLIPPER_VERSION" "occt-import-js@$OCCT_VERSION" esbuild >/dev/null

# three.js core + OrbitControls in one minified ES module.
cat > three-entry.js <<'JS'
export * from 'three';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
JS
npx esbuild three-entry.js --bundle --format=esm --minify --legal-comments=eof \
  --outfile="$ROOT/vendor/three.bundle.min.js"

# Clipper (UMD) wrapped as an ES module so it works in module workers and Node.
{
  echo 'const module = { exports: {} };'
  cat node_modules/clipper-lib/clipper.js
  echo 'export default module.exports;'
} > clipper-esm.js
npx esbuild clipper-esm.js --format=esm --minify --legal-comments=eof \
  --outfile="$ROOT/vendor/clipper.min.js"

# occt-import-js (OpenCascade STEP import, UMD + WebAssembly), wrapped as an ES module.
mkdir -p "$ROOT/vendor/occt"
{
  echo "// occt-import-js $OCCT_VERSION (LGPL-2.1, https://github.com/kovacsv/occt-import-js), wrapped as an ES module."
  echo 'const module = { exports: {} }; const exports = module.exports;'
  cat node_modules/occt-import-js/dist/occt-import-js.js
  echo
  echo 'export default module.exports;'
} > "$ROOT/vendor/occt/occt-import-js.esm.js"
cp node_modules/occt-import-js/dist/occt-import-js.wasm node_modules/occt-import-js/dist/license.*.txt "$ROOT/vendor/occt/"

echo "vendor/ rebuilt (three $THREE_VERSION, clipper-lib $CLIPPER_VERSION, occt-import-js $OCCT_VERSION)"
