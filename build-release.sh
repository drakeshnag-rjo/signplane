#!/usr/bin/env bash
# build-release.sh — assemble the Signplane release bundle (macOS / Linux).
# Output: dist/signplane-<version>.zip + .sha256, per-file CHECKSUMS.txt inside.
# Windows equivalent: build-release.ps1
set -euo pipefail
VERSION="${1:-1.1.0}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="signplane-$VERSION"
STAGING="$ROOT/dist/$NAME"

SHACMD="sha256sum"
command -v sha256sum >/dev/null 2>&1 || SHACMD="shasum -a 256"

rm -rf "$ROOT/dist"
mkdir -p "$STAGING/docs"

for f in server.js executor.py policies.json demo-agent-aws.js demo-agent-scheduled.js \
         mcp-server.js dev.js reset-demo.sh LICENSE CONTRIBUTING.md SECURITY.md; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$STAGING/"
done
for d in lib public examples clients; do
  cp -r "$ROOT/$d" "$STAGING/$d"
done
for d in INSTALL.md pilot-runbook.md install-phase0.md connecting-agents.md API.md CONFIGURATION.md; do
  [ -f "$ROOT/docs/$d" ] && cp "$ROOT/docs/$d" "$STAGING/docs/"
done
cp "$ROOT/docs/INSTALL.md" "$STAGING/INSTALL.md"

printf 'signplane %s\nbuilt %s\n' "$VERSION" "$(date -u +%FT%TZ)" > "$STAGING/VERSION"

( cd "$STAGING" && find . -type f ! -name CHECKSUMS.txt -print0 | sort -z \
    | xargs -0 $SHACMD | sed 's|\./||' > CHECKSUMS.txt )

( cd "$STAGING" && zip -qr "../$NAME.zip" . )
( cd "$ROOT/dist" && $SHACMD "$NAME.zip" > "$NAME.zip.sha256" )

echo "Built $ROOT/dist/$NAME.zip"
$SHACMD "$ROOT/dist/$NAME.zip"
