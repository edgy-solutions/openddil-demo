#!/usr/bin/env bash
# Runs dis-event-report.yaml's unit tests, plus a lint pass of the DIS
# ingress pipeline with CM_* unset and with them set. Self-contained: no
# broker, no daemon, just the pinned connect image. Safe to wire into CI
# as-is.
#
#   ./run.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# Pinned to match the chart's connect image (openddil-helm). MSYS_NO_PATHCONV
# is set only around the docker invocations below: Git Bash on Windows
# otherwise mangles the leading "/" in in-container paths like /tests/... as
# if they were local paths needing drive-letter conversion.
IMAGE="docker.redpanda.com/redpandadata/connect:4.91.0"

fail=0

echo "== connect test: dis-event-report_test.yaml =="
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$REPO/dynamic-mappings:/dynamic-mappings:ro" \
  -v "$HERE:/tests:ro" \
  "$IMAGE" test --verbose "/tests/dis-event-report_test.yaml"
[ $? -eq 0 ] || fail=1

echo
echo "== connect lint: openddil-base-connect.yaml + dynamic-mappings/, CM_* unset =="
# All positional, NOT -r: this image's `lint` does not glob-expand a -r
# value (confirmed empirically against 4.91.0 -- `echo` and `test` both
# glob-expand -r fine, `lint` does not), but it does glob-expand and
# cross-resolve resources across multiple positional file args.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$REPO/openddil-base-connect.yaml:/connect.yaml:ro" \
  -v "$REPO/dynamic-mappings:/mappings:ro" \
  "$IMAGE" lint "/connect.yaml" "/mappings/*.yaml"
[ $? -eq 0 ] || fail=1

echo
echo "== connect lint: openddil-base-connect.yaml + dynamic-mappings/, CM_* set =="
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$REPO/openddil-base-connect.yaml:/connect.yaml:ro" \
  -v "$REPO/dynamic-mappings:/mappings:ro" \
  -e CM_EVENT_REPORT_TYPE="9001" \
  -e CM_EVENT_REPORT_COMPONENT_DATUM="70001" \
  -e CM_EVENT_REPORT_FAULT_CODE_DATUM="70002" \
  -e CM_EVENT_REPORT_DESCRIPTION_DATUM="70003" \
  -e CM_EVENT_REPORT_SEVERITY="MAJOR" \
  -e CM_EVENT_REPORT_RECORDED_BY="system:dis-event-report" \
  -e CM_EVENT_REPORT_SOURCE="telemetry_bit" \
  -e CM_INTAKE_URL="http://cm-intake:4197/cm-events" \
  "$IMAGE" lint "/connect.yaml" "/mappings/*.yaml"
[ $? -eq 0 ] || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN"
else
  echo "FAILED -- see above"
fi
exit $fail
