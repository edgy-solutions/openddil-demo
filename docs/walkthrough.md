# OpenDDIL Demo — End-to-End Architecture Walkthrough

This document traces a single piece of data from the edge sensor feeds all
the way to the customer-facing battle management product, naming every
file and component it touches. Current as of Phase 3.5 (2026-05-13).

## The big picture

```
EDGE                                                                   ENTERPRISE
────                                                                   ──────────
  DIS UDP ─► dis_ingestor.py ──► ingress-dis-raw                                ┐
                                  │                                             │
  HTTP POST ─► proprietary_ingestor.py ──► ingress-proprietary-raw              │
                                  │                                             │
  RabbitMQ ─► [Connect amqp_0_9] ─► ingress-sim-a-raw                           │
              (no Python sidecar)   │                                           │  (cm-service)
                                    ▼                                           │
                       redpanda-connect (Bloblang)                              │
                         + sim-dis-mapping.yaml                                 │
                         + proprietary-mapping.yaml                             │
                         + sim-a-mapping.yaml                                   │
                                    │                                           │
                                    ▼                                           │
                          raw-sensor-stream (Silver)                            │
                                    │                                           │
                ┌───────────────────┼───────────────────┐                       │
                ▼                   ▼                   ▼                       │
         faust-edge          cm-service          logistics-fusion               │
        (windowing)         (AssetCM VO)         (AssetLogistics VO)            │
                │                   │                   │                       │
                ▼                   ▼                   ▼                       │
   asset-telemetry-windows   asset-cm-state    asset-logistics-status           │
                                    │                   │                       │
                                    └──────► fusion ◄───┘                       │
                                                │                               │
                                                ▼                               │
                            redpanda-connect-egress (Bloblang)                  │
                              + dynamic-mappings/egress/system-b-egress.yaml    │
                                                │                               │
                                                ▼                               │
                            RabbitMQ exchange battle-mgmt.asset-status          │
                            (consumed by System B battle management product)
```

## The dual-feed boundary (Phase 3.5)

OpenDDIL absorbs three external feeds today. Each lives at a transport
boundary; **shape translation always happens in Bloblang**, never in Python.

| Feed | Transport | Sidecar | Bloblang Mapping |
|---|---|---|---|
| DIS (simulation/training) | UDP binary | [dis_ingestor.py](openddil-sensor-ingest/dis_ingestor.py) — binary PDU parsing requires the `opendis` library | [dynamic-mappings/sim-dis-mapping.yaml](openddil-demo/dynamic-mappings/sim-dis-mapping.yaml) |
| Proprietary sensor | HTTP POST JSON | [proprietary_ingestor.py](openddil-sensor-ingest/proprietary_ingestor.py) — validates + transliterates to Bronze | [dynamic-mappings/proprietary-mapping.yaml](openddil-demo/dynamic-mappings/proprietary-mapping.yaml) |
| Sim-A (proprietary battle sim) | RabbitMQ AMQP JSON | **None** — Redpanda Connect's `amqp_0_9` input handles RabbitMQ natively | [dynamic-mappings/sim-a-mapping.yaml](openddil-demo/dynamic-mappings/sim-a-mapping.yaml) |

The Sim-A line is the cleanest example of the Phase 3.5 architectural
principle: **Connect at the protocol boundary; Bloblang at the shape
boundary**. When a Connect input speaks the source protocol natively,
no Python sidecar is needed — the transport plumbing IS the sidecar.

### Configuration injection points

Three artifacts are deliberately exposed for customer integration:

1. **`openddil-demo/dynamic-mappings/sim-a-mapping.yaml`** — when System A's
   real ICD lands, only the Bloblang here changes. The sidecar (or absence
   of one), the Kafka topics, and the Silver schema all stay put.
2. **`openddil-demo/dynamic-mappings/egress/system-b-egress.yaml`** — when
   System B's real JSON ICD lands, only this file changes.
3. **`openddil-contracts/ontology/asset_identity_aliases.yaml`,
   `platform_variant_aliases.yaml`, `platform_reference.yaml`** — domain-
   curated reference data; PR-reviewed, hot-reloadable. Captures what each
   external feed calls each asset/variant/platform and what intrinsic
   properties (fuel capacity, etc.) the platform has.

## Per-asset durable workflows (Restate)

Two Virtual Object services run on the same Restate instance:

- **AssetCM** (cm-service) — As-Maintained configuration state per asset.
  See [openddil-cm-service/src/events/asset_cm.py](openddil-cm-service/src/events/asset_cm.py).
- **AssetLogistics** (logistics-fusion-service) — fused logistics severity
  per asset, combining windowed telemetry, CM state, and live sustainment.
  See [openddil-logistics-fusion-service/src/workflows/asset_logistics.py](openddil-logistics-fusion-service/src/workflows/asset_logistics.py)
  and the [topology doc](openddil-logistics-fusion-service/docs/topology.md).

Both services share a single Restate-subscription registration library:
[openddil-contracts/bootstrap/restate_subscriptions.py](openddil-contracts/bootstrap/restate_subscriptions.py).
Each service has a thin wrapper that owns its own subscription list and
delegates the actual registration to the shared library. New Restate
services follow the same wrapper pattern.

## Customer-facing vocabulary

Internal severity vocabulary is stable and tested: `LOGISTICS_SEVERITY_OK`,
`LOGISTICS_SEVERITY_DEGRADED`, `LOGISTICS_SEVERITY_CRITICAL`,
`LOGISTICS_SEVERITY_NON_OPERATIONAL`. Customer-facing labels (FMC/PMC/NMC,
green/amber/red, etc.) are applied at the **egress** boundary via a
Bloblang `match` block — never inside the fusion service.

Demonstrated by [Test 28](openddil-demo/tests/hero_scenario_v3/test_28_egress_vocab_swap.py):
swapping `system-b-egress.yaml` with `system-b-egress-fmc.yaml` changes
the customer label from `"CRITICAL"` to `"PMC"` with no Python touched
and no service rebuilt.

## What's NOT in this walkthrough

- Phase 4 COP UI (the customer's display surface) — separate document.
- The future identity-resolver service ([ADR-0015](openddil-contracts/decisions/ADR-0015-identity-resolution-asymmetry.md)).
- The Phase 4-deferred decisions about lifecycle modeling for
  AssetLogistics (currently inlined as a staleness ConstrainingFactor).
