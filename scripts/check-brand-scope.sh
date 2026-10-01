#!/usr/bin/env bash
# ===========================================================================
# check-brand-scope.sh — does the ungated /brand/ location serve ONLY the
# shipped brand images?
# ===========================================================================
# Usage: check-brand-scope.sh BASE_URL
#   BASE_URL  the UI origin, e.g. http://localhost:8080 (no trailing slash)
#
# WHY. frontend/nginx.conf deliberately leaves `location ^~ /brand/` outside
# the session gate so the sign-in screen can show its own logo before any
# session exists. An ungated prefix is only safe while it can return nothing
# but the files in frontend/public/brand/. The two ways it stops being safe
# are both one-line config edits: an SPA fallback (`try_files ... /index.html`)
# turns every unknown /brand/ path into the app shell, and `autoindex on`
# turns /brand/ into a listing. Both answer 200 with no session.
#
# HOW. Requests carry no cookie, so they are what a signed-out browser sends.
#   - each file in frontend/public/brand/ must be 200 image/* at its repo size
#   - every other /brand/ path must be 404 (missing file, missing non-image,
#     the bare directory, a subdirectory)
#   - traversal (`..`, encoded `..`) and a lookalike prefix must not come back
#     200 from the /brand/ block. That block is recognisable by the
#     `Cache-Control: max-age=3600` its `expires 1h` adds; a 200 without it
#     came from another location, whose gate is its own business.
# Exit 0 = /brand/ serves only its files; exit 1 = it serves something else,
# or the check could not run.
set -uo pipefail

BASE="${1:?usage: check-brand-scope.sh BASE_URL}"
BRAND_DIR="$(cd "$(dirname "$0")/../frontend/public/brand" && pwd)" || { echo "no frontend/public/brand -- check did not run"; exit 1; }
fail=0; n=0

probe() { # path -> "code|content_type|size|cache_control"
  curl -s --path-as-is -o /dev/null -D - -w '\n%{http_code}|%{content_type}|%{size_download}' "$BASE$1" 2>/dev/null \
    | awk 'BEGIN{IGNORECASE=1} /^cache-control:/{cc=$0; sub(/\r$/,"",cc); sub(/^[^:]*: */,"",cc)} END{printf "%s|%s", last, cc} {last=$0}'
}
row() { printf '%-44s %-30s %s\n' "$1" "$2" "$3"; }

# A curl that cannot write its output reports 0 bytes downloaded, which would
# read as a server fault on every row. (Git Bash with MSYS_NO_PATHCONV=1 hands
# curl.exe a literal /dev/null it cannot open.) Say so instead.
curl -s -o /dev/null "$BASE/brand/"; rc=$?
[ "$rc" -eq 0 ] || { echo "curl exit $rc on $BASE/brand/ -- check did not run"; exit 1; }

row PATH RESULT VERDICT
for f in "$BRAND_DIR"/*; do
  name=$(basename "$f"); want=$(wc -c < "$f" | tr -d ' ')
  IFS='|' read -r code ctype size cc <<<"$(probe "/brand/$name")"; n=$((n+1))
  if [ "$code" = 200 ] && [[ "$ctype" == image/* ]] && [ "$size" = "$want" ]; then v=ok; else v="FAIL (want 200 image/* $want bytes)"; fail=1; fi
  row "/brand/$name" "$code $ctype $size" "$v"
done
[ "$n" -ge 1 ] || { echo "no files in $BRAND_DIR -- check did not run"; exit 1; }

for p in /brand/ /brand/no-such-file.png /brand/no-such-file.html /brand/index.html /brand/x/; do
  IFS='|' read -r code ctype size cc <<<"$(probe "$p")"
  if [ "$code" = 404 ]; then v=ok; else v="FAIL (want 404: /brand/ must not answer for a file it does not ship)"; fail=1; fi
  row "$p" "$code $ctype" "$v"
done

# /brand../ is the alias off-by-slash: `location /brand { alias .../brand/; }`
# maps it to the PARENT of the brand directory.
for p in /brand/../index.html /brand/%2e%2e/index.html /brand/..%2f..%2fetc%2fpasswd /brand/%2e%2e/deployment/deployment.json /brand../index.html /brandx/logo.png; do
  IFS='|' read -r code ctype size cc <<<"$(probe "$p")"
  if [ "$code" = 200 ] && [[ "$cc" == *max-age=3600* ]]; then v="FAIL (200 from the /brand/ block for a path outside it)"; fail=1; else v=ok; fi
  row "$p" "$code $ctype${cc:+ [$cc]}" "$v"
done

echo
[ "$fail" -eq 0 ] && echo "brand scope: /brand/ serves only its $n files" || echo "brand scope: FAILED"
exit "$fail"
