# Exercise control — compose proof

What `compose_proof.sh` measures against a running compose stack, and
what it does not (those are covered by pytest instead, named below).

## Prerequisites

```
docker compose up -d gateway                     # base stack, header-mode PEP
docker compose -f docker-compose.yml -f docker-compose.exercise.yml \
  --profile exercise up -d exercise-stub-adapter exercise-control
```

`openddil-sensor-ingest-01` must already be running (its own base
service). The script does not start or stop anything outside the
`exercise` profile's own two services, and never runs
`docker compose down`.

## How the calls are made

Through the gateway's own listener, from inside the gateway container
(`docker compose exec gateway python3 -c '<urllib script>'` against
`http://127.0.0.1:8080`) — not through the frontend's nginx. The
frontend image running in compose is pulled pre-built
(`ghcr.io/edgy-solutions/openddil/frontend:latest`); the new `/exercise/`
nginx location this change adds (`frontend/nginx.conf`) is a source
change for the *next* build of that image, not something the
already-running container has yet. Hitting the gateway directly is the
literal "through the gateway" path, and needs no new host
port mapping.

Subjects (from `policy/users.yaml`, already seeded for the demo):
- supervisor: `33333333-3333-4333-8333-333333333333`
- viewer (edge-operator, not exercise-control): `11111111-1111-4111-8111-111111111111`

## Predictions

| # | Scenario | Predicted | Measured |
|---|----------|-----------|----------|
| 1 | supervisor POST run | within 35 s, activity running; last command "run -> 200" | filled in by the script |
| 2 | supervisor POST pause | within 35 s, activity paused; last command "pause -> 200" | filled in by the script |
| 3 | supervisor POST resume | running within 35 s | filled in by the script |
| 4 | viewer POST pause | 403; stub `/requests` count unchanged | filled in by the script |
| 5 | GET `/proxies/<stub-like>` and `/exercise/../...` | 404; no route to the stub | filled in by the script |
| 6 | stub container stopped, then supervisor POST pause | last command carries the transport error; activity stays rate-derived (paused once the simulator stops sending — never "running" from the record) | filled in by the script |

`compose_proof.sh` prints `PASS`/`FAIL` per row and a final summary; it
exits non-zero if any row failed.

## Fail-on-purpose cases (covered by unit tests, not this script)

These need an env knob the default `exercise` profile does not set, so
they are proven once, deterministically, under pytest rather than as a
timing-dependent live-compose step:

- **`STUB_LIE_STATE=running` while actually paused still reads as
  paused**: `exercise/test_stub_adapter.py::test_stub_lie_state_claims_running_while_actually_paused`
  proves the stub's own response body lies; `exercise/control.py`'s
  `call_adapter` (and `exercise/test_control.py`'s adapter-lies test)
  prove the lie never crosses into `last_command` or `activity` — only
  the HTTP status code does.
- **A rate source pointed at a dead URL reads as unknown, never
  paused**: `exercise/test_control.py`'s `derive_state` unit tests
  (`test_...unreachable...`) cover this directly; see also the rule at
  the top of `exercise/control.py` and `frontend/src/lib/exerciseControl.ts`.

## No simulator-product/customer naming

Nothing in this file, `compose_proof.sh`, or the services it drives
names the entity simulator's product, a customer, a lab or a site; see
`exercise/control.py`'s and `exercise/stub_adapter.py`'s own headers for
the same rule.
