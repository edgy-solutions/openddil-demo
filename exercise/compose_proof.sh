#!/usr/bin/env bash
# exercise/compose_proof.sh -- measures the 6 numbered predictions in
# exercise/COMPOSE-PROOF.md against a running compose stack. Prints
# PASS/FAIL per row and a measured-vs-predicted table; exits non-zero if
# any row failed.
#
# Do NOT run this against anything but compose. It assumes:
#   docker compose up -d gateway
#   docker compose -f docker-compose.yml -f docker-compose.exercise.yml \
#     --profile exercise up -d exercise-stub-adapter exercise-control
# with openddil-sensor-ingest-01 already running as part of the base
# stack. It never runs `docker compose down`, and the only container
# lifecycle action it takes itself is stopping exercise-stub-adapter for
# prediction 6 (see COMPOSE-PROOF.md) -- a service this script's own
# prerequisites just started under the `exercise` profile, not a
# pre-existing one.
#
# Calls go through the gateway's own listener (127.0.0.1:8080 inside its
# own container, via `docker compose exec`), not through the frontend --
# see COMPOSE-PROOF.md for why.
set -u -o pipefail

# Git Bash rewrites a "/exercise/..." argument into a Windows path before it
# reaches `docker compose exec`; this is a no-op on Linux and macOS.
export MSYS_NO_PATHCONV=1
# Host-side JSON parsing: python3 where it exists, the py launcher otherwise.
if command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1; then PYTHON=(python3); else PYTHON=(py -3); fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.exercise.yml)

SUPERVISOR_SUBJECT="33333333-3333-4333-8333-333333333333"
VIEWER_SUBJECT="11111111-1111-4111-8111-111111111111"

RATE_WINDOW_PLUS_SCRAPE=35

FAILED=0
declare -a ROWS=()

note() { printf '%s\n' "$*" >&2; }

# call <subject> <method> <path> -> prints "STATUS<TAB>BODY", one line
call() {
  local subject="$1" method="$2" path="$3"
  "${COMPOSE[@]}" exec -T gateway python3 - "$subject" "$method" "$path" <<'PY'
import sys, urllib.request, urllib.error
subject, method, path = sys.argv[1], sys.argv[2], sys.argv[3]
req = urllib.request.Request(f"http://127.0.0.1:8080{path}", method=method,
                              data=(b"" if method == "POST" else None))
if subject:
    req.add_header("X-OpenDDIL-Subject", subject)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"{r.status}\t{r.read().decode()}")
except urllib.error.HTTPError as e:
    print(f"{e.code}\t{e.read().decode()}")
except Exception as e:  # noqa: BLE001 -- transport fault is the result being measured
    print(f"ERR\t{e}")
PY
}

# call_raw_path <subject> <literal-request-target> -> "STATUS<TAB>BODY"
# Unlike call(), sends the request-target byte-for-byte via http.client
# (urllib.request would normalize "/exercise/../healthz" before it ever
# reaches the wire) -- needed for prediction 5's "/exercise/../" case.
call_raw_path() {
  local subject="$1" target="$2"
  "${COMPOSE[@]}" exec -T gateway python3 - "$subject" "$target" <<'PY'
import sys, http.client
subject, target = sys.argv[1], sys.argv[2]
conn = http.client.HTTPConnection("127.0.0.1", 8080, timeout=10)
headers = {"X-OpenDDIL-Subject": subject} if subject else {}
try:
    conn.putrequest("GET", target, skip_host=True, skip_accept_encoding=True)
    conn.putheader("Host", "127.0.0.1")
    for k, v in headers.items():
        conn.putheader(k, v)
    conn.endheaders()
    r = conn.getresponse()
    print(f"{r.status}\t{r.read().decode()}")
except Exception as e:  # noqa: BLE001
    print(f"ERR\t{e}")
finally:
    conn.close()
PY
}

stub_requests_count() {
  "${COMPOSE[@]}" exec -T exercise-stub-adapter python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen("http://127.0.0.1:8096/requests", timeout=10) as r:
    print(len(json.loads(r.read())["requests"]))
PY
}

activity_state() {  # <status-json-line (STATUS<TAB>BODY)>
  "${PYTHON[@]}" -c "import sys, json; print(json.loads(sys.argv[1].split('\t',1)[1])['activity']['state'])" "$1"
}

last_command_field() {  # <status-json-line> <field>
  "${PYTHON[@]}" -c "
import sys, json
body = json.loads(sys.argv[1].split('\t', 1)[1])
lc = body.get('last_command')
print('' if lc is None else lc.get(sys.argv[2], ''))
" "$1" "$2"
}

record() {  # record <name> <predicted> <measured>
  local name="$1" predicted="$2" measured="$3"
  ROWS+=("$name|$predicted|$measured")
  if [ "$predicted" = "$measured" ]; then
    note "PASS  $name -- predicted=[$predicted] measured=[$measured]"
  else
    note "FAIL  $name -- predicted=[$predicted] measured=[$measured]"
    FAILED=1
  fi
}

note "== prediction 1: supervisor run -> running within ${RATE_WINDOW_PLUS_SCRAPE}s =="
run_resp="$(call "$SUPERVISOR_SUBJECT" POST /exercise/op/run)"
record "1a run op status" "200" "$(printf '%s' "$run_resp" | cut -f1)"
sleep "$RATE_WINDOW_PLUS_SCRAPE"
status1="$(call "$SUPERVISOR_SUBJECT" GET /exercise/status)"
record "1b activity after run" "running" "$(activity_state "$status1")"
record "1c last_command.op after run" "run" "$(last_command_field "$status1" op)"
record "1d last_command.status after run" "200" "$(last_command_field "$status1" status)"

note "== prediction 2: supervisor pause -> paused within ${RATE_WINDOW_PLUS_SCRAPE}s =="
pause_resp="$(call "$SUPERVISOR_SUBJECT" POST /exercise/op/pause)"
record "2a pause op status" "200" "$(printf '%s' "$pause_resp" | cut -f1)"
sleep "$RATE_WINDOW_PLUS_SCRAPE"
status2="$(call "$SUPERVISOR_SUBJECT" GET /exercise/status)"
record "2b activity after pause" "paused" "$(activity_state "$status2")"
record "2c last_command.op after pause" "pause" "$(last_command_field "$status2" op)"

note "== prediction 3: supervisor resume -> running within ${RATE_WINDOW_PLUS_SCRAPE}s =="
call "$SUPERVISOR_SUBJECT" POST /exercise/op/resume >/dev/null
sleep "$RATE_WINDOW_PLUS_SCRAPE"
status3="$(call "$SUPERVISOR_SUBJECT" GET /exercise/status)"
record "3 activity after resume" "running" "$(activity_state "$status3")"

note "== prediction 4: viewer POST pause -> 403, stub call count unchanged =="
count_before="$(stub_requests_count)"
viewer_resp="$(call "$VIEWER_SUBJECT" POST /exercise/op/pause)"
count_after="$(stub_requests_count)"
record "4a viewer pause status" "403" "$(printf '%s' "$viewer_resp" | cut -f1)"
record "4b stub call count unchanged" "$count_before" "$count_after"

note "== prediction 5: no route to the stub through /proxies or path tricks =="
p5a="$(call "$SUPERVISOR_SUBJECT" GET /proxies/exercise-stub-adapter)"
record "5a GET /proxies/<stub-like>" "404" "$(printf '%s' "$p5a" | cut -f1)"
p5b="$(call_raw_path "$SUPERVISOR_SUBJECT" "/exercise/../healthz")"
record "5b GET /exercise/../healthz" "404" "$(printf '%s' "$p5b" | cut -f1)"

note "== prediction 6: stub stopped -> transport error recorded, activity stays rate-derived =="
"${COMPOSE[@]}" stop exercise-stub-adapter >/dev/null 2>&1
sleep 2
p6_resp="$(call "$SUPERVISOR_SUBJECT" POST /exercise/op/pause)"
status6="$(call "$SUPERVISOR_SUBJECT" GET /exercise/status)"
err6="$(last_command_field "$status6" error)"
record "6a last_command has a transport error" "nonempty" "$([ -n "$err6" ] && echo nonempty || echo empty)"
# Stopping the stub's container ends its simulator child too, so the rate
# falls to zero: after a full window the state is paused. That comes from the
# rate, not from the failed pause op. An empty or unparsed status is a miss,
# not a pass.
sleep "$RATE_WINDOW_PLUS_SCRAPE"
status6b="$(call "$SUPERVISOR_SUBJECT" GET /exercise/status)"
record "6b activity a window after the stub stopped" "paused" "$(activity_state "$status6b")"
note "NOTE: restart exercise-stub-adapter yourself before relying on this stack further:"
note "      ${COMPOSE[*]} start exercise-stub-adapter"

note ""
note "== summary =="
for row in "${ROWS[@]}"; do
  IFS='|' read -r name predicted measured <<<"$row"
  printf '%-45s predicted=%-10s measured=%-10s\n' "$name" "$predicted" "$measured" >&2
done

if [ "$FAILED" -ne 0 ]; then
  note ""
  note "one or more predictions did not match -- see FAIL lines above."
  exit 1
fi
note ""
note "all predictions matched."
