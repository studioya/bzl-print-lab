#!/usr/bin/env bash
# Rebuilds the vendored third-party libraries in vendor/.
# Usage: tools/vendor.sh   (needs npm; run from the repo root)
set -euo pipefail
THREE_VERSION=0.186.1
CLIPPER_VERSION=6.4.2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm install --no-audit --no-fund "three@$THREE_VERSION" "clipper-lib@$CLIPPER_VERSION" esbuild >/dev/null

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

echo "vendor/ rebuilt (three $THREE_VERSION, clipper-lib $CLIPPER_VERSION)"
