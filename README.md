# OpenDDIL Tactical Telemetry Edge (Demo)

This environment provides a high-fidelity, schema-first edge telemetry pipeline for tactical assets. It handles ingestion, transformation, and real-time anomaly detection.

## 🚀 Key Accomplishments
- **Schema-First Architecture**: Standardized on Protobuf v1 with full unit support (`Quantity`) — every physical scalar carries its source unit (ADR-0013).
- **Multi-feed Ingress** (Phase 3): DIS binary on UDP:62040, proprietary `SensorMessage` JSON on HTTP:9095, both feeding the same Silver schema (ADR-0010). Diagnostic HTTP path on :9999.
- **Configuration Management Service** (Phase 3): Restate Virtual Object `AssetCM` per asset_id with durable state, scheduled per-asset recheck timers, lifecycle state machine, and CloudEvent-on-transition alerting. See `openddil-cm-service/`.
- **Hardened Faust Processing**: Snappy-enabled Python 3.10 agents with Persistence/Computation model separation.
- **Offline-First UI**: Cortex UI with ElectricSQL synchronization and a defined staleness contract.
- **Observability**: Built-in DLQ for malformed payloads and CloudEvent-formatted anomaly alerts.

## 🏗 Deployment vs. Development
The system uses the **Docker Compose Override Pattern** to separate production-ready images from local development needs:
- **`docker-compose.yml`**: Contains only pre-built, tagged images. Safe for tactical edge deployments.
- **`docker-compose.override.yml`**: Automatically loaded during local dev. It enables `build` blocks and mounts your local code into the containers for instant hot-reloading.
- **Usage**: Simply run `docker compose up`. Docker will automatically merge the two files.

## 🛠 Architectural Principles (ADRs)
- **[ADR-0007: Unit Handling](../openddil-contracts/docs/adr-0007-unit-handling.md)**: Carry Units, Defer Conversion. No math in the transformation layer.
- **[ADR-0008: CloudEvents](../openddil-contracts/docs/adr-0008-cloudevents-binding.md)**: Structured Mode binding for portable tactical alerts.
- **[ADR-0009: CM Data Model](../openddil-contracts/decisions/ADR-0009-configuration-management-data-model.md)**: Configuration Items, baselines, modification requirements, discrepancies.
- **[ADR-0010: Feed Integration](../openddil-contracts/decisions/ADR-0010-feed-integration-strategy.md)**: External feeds adapt to the Silver schema, never the reverse.
- **[ADR-0013: Quantity Everywhere](../openddil-contracts/decisions/ADR-0013-physical-quantity-consistency.md)**: All physical scalars are `Quantity{value,unit}`.
- **[ADR-0014: Restate vs Faust](../openddil-contracts/decisions/ADR-0014-restate-vs-faust-placement.md)**: When to use each engine, and why CM is Restate.

## 🔌 Dynamic Ingress Configuration
The system is designed for **Any Protocol Ingestion** without code changes. This is achieved via:
- **Volume Injection**: The `./dynamic-mappings` directory is mounted into the Redpanda Connect container at `/mappings`.
- **Resource Loading**: The container command `run -r "/mappings/*.yaml" /connect.yaml` tells the engine to watch and hot-reload all YAML files in that directory.
- **Resource Decoupling**: The main `openddil-base-connect.yaml` refers to a generic `resource: "sim_dis_mapping"`. This mapping is defined in the injected files, allowing you to swap out or add protocol translations (AIS, Link-16, etc.) by simply dropping a new YAML into the host directory.

## ✅ Verification: The Hero Scenario (v2.1)
Run these tests to verify the integrity of the architecture:

1. **Symmetrical DLQ**: `echo "GARBAGE" | nc -u -w1 localhost 62040` -> Check `ingress-dlq` topic.
2. **Truth Serum (Units)**: Send `200 K` (Cold) vs `200 F` (Hot). Use `tests/test_udp_final.py`.
3. **Offline-First**: Load UI -> Sever WAN link (Toxiproxy) -> Wait 30s -> Verify staleness banner and local cache render.

> **DDIL demo staging — the sim-a feed must be active.** The Phase 4c.5
> edge→HQ buffer counter reads *real* `bridge-group` consumer-group lag:
> messages queued at the edge because the HQ link is severed. That number
> only **climbs** while traffic is actually flowing into the edge — i.e.
> while the sim-a feed (or another live feed) is producing. If the feeds
> are idle or stale, severing the link is still genuinely real (the
> `hq_link_severed` state flips, the SYSTEM FREEZE overlay fires), but the
> buffer stays at 0 because there is nothing to buffer. **Before demoing
> the sever → buffer-climbs → restore → buffer-drains cycle, confirm the
> sim-a feed is live** (`rpk topic consume raw-sensor-stream` should show
> fresh records). The mechanism is verified; the *visual* needs traffic.

## 🗺 Tactical Roadmap

Done:
- ✅ Binary DIS PDU decoder + DIS Entity Type ontology (Phase 2)
- ✅ Quantity-everywhere schema migration (Phase 2.5, ADR-0013)
- ✅ Configuration Management service on Restate (Phase 3, ADR-0014)
- ✅ Proprietary feed shim — SensorMessage → Silver via Bloblang (Phase 3, ADR-0010)
- ✅ Asset identity reconciliation across feeds via `asset_identity_aliases.yaml`
- ✅ COP UI views (Phase 4): Maintainer / Regional / HQ over `asset-cm-state` via ElectricSQL
- ✅ Phase 5 prognostics derivation (ADR-0020): track / engine / suspension wear models
  emitting `derived-sustainment`; logistics-fusion `_eval_wear` percent-aware branch
  stamps `origin = ORIGIN_DERIVED` on resulting `ConstrainingFactor`s. Phase 5 closed
  at step 2; barrel-life model built but dormant (see future phases below)
- ✅ Phase 6 hierarchical-aggregation restoration (ADRs 0021–0024):
  6a per-edge clusters, 6b regional aggregator + rollup tables, 6c UI rewiring
  to three-tier role views with per-edge scope on the maintainer side

Future phases (no committed sequencing — `tests/hero_scenario_v3/README.md` is the
detailed source of truth for tracked follow-ups and named future phases):

- **Capability-snapshot delta wiring + barrel-life activation** — activates the
  dormant `wear.barrel` model via the customer's `StrikeCapabilityMessage` feed;
  Ammo deltas synthesize `rounds_fired` events. Recipe written 2026-05-19; gated
  on transport + queue topology confirmation.
- **ALCS / EAGLE egress bridges** — mock egress closing the loop from anomaly to
  enterprise work order. The HQ "Enterprise CM Recommendations" panel currently
  surfaces CM-derived recommendations as a placeholder; real egress wiring is
  ADR-0022-constrained future work.
- **DIS Fire/Detonation PDU ingestion** — deferred to a VRForces / AFSim
  integration phase (the customer's existing feed does not include DIS Fire/
  Detonation events; this path activates when a real DIS fire-event source
  arrives).
- **VR-Forces / AFSim integration** — the contractual milestone.
- **Dead Reckoning** — DR algorithms in faust-edge for sparse (~5 Hz) DIS updates.
- **Egress (OpenDDIL → DIS)** — bidirectional simulation feedback.
- **CI tracking / cm-items topic** — serialized component instances + bill-of-
  materials hierarchy.

---
**Status**: Production-ready for Windows/Linux dev. Qualified for Linux Edge deployment.