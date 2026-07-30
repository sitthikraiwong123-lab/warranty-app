#!/bin/sh
# Bumps the patch version and stamps today's date in the app header:
#
#     v2.9.1 · 18-Jul-2026   ->   v2.9.2 · 30-Jul-2026
#
# Usable two ways:
#   ./tools/bump-version.sh          bump now, unconditionally
#   installed as .git/hooks/pre-commit   bump on any commit touching the app
#
# To install the hook (each clone needs this once — .git/hooks is not tracked):
#   cp tools/bump-version.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Perl, not sed: the separator is U+00B7 (·, bytes C2 B7) and the file is a
# 1.4 MB mix of UTF-8 Thai and base64 blobs. -CSD decodes the whole file as
# UTF-8 so the multi-byte character survives the rewrite untouched. The regex
# itself stays pure ASCII (.{0,5}? spans the separator) because a literal ·
# inside a -e script is NOT decoded and silently fails to match.
set -e

FILE="Warranty App.html"
cd "$(git rev-parse --show-toplevel)"
[ -f "$FILE" ] || { echo "bump-version: $FILE not found" >&2; exit 1; }

# Pulls "v2.9.1 30-Jul-2026" out of a stream. Requires the DATE to follow the
# version, which is what keeps it from matching version-shaped noise inside the
# embedded base64 images and fonts.
extract_ver() {
  perl -CSD -ne 'if (/(v\d+\.\d+\.\d+).{0,5}?(\d{2}-[A-Za-z]{3}-\d{4})/) { print "$1 $2"; exit }'
}

# --- hook mode ---------------------------------------------------------------
# Called as pre-commit: do nothing unless the app file is part of this commit,
# and do nothing if its version was already changed by hand — otherwise a
# deliberate manual bump would land as a double bump.
if [ "$(basename "$0")" = "pre-commit" ]; then
  git diff --cached --name-only --diff-filter=ACM | grep -qxF "$FILE" || exit 0

  STAGED=$(git show ":$FILE" | extract_ver)
  HEAD_V=$(git show "HEAD:$FILE" 2>/dev/null | extract_ver || true)
  if [ -n "$HEAD_V" ] && [ "$STAGED" != "$HEAD_V" ]; then
    echo "bump-version: version already changed by hand ($HEAD_V -> $STAGED), leaving it"
    exit 0
  fi
fi

BEFORE=$(extract_ver < "$FILE")

TODAY=$(date +"%d-%b-%Y") perl -CSD -i -pe '
  s{(v)(\d+)\.(\d+)\.(\d+)(.{0,5}?)(\d{2}-[A-Za-z]{3}-\d{4})}
   {$1.$2.".".$3.".".($4+1).$5.$ENV{TODAY}}e
' "$FILE"

AFTER=$(extract_ver < "$FILE")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "bump-version: version string not found or unchanged — check $FILE" >&2
  exit 1
fi
echo "bump-version: $BEFORE -> $AFTER"

# Re-stage so the bump is part of the commit being made, not left dangling.
[ "$(basename "$0")" = "pre-commit" ] && git add "$FILE"
exit 0
