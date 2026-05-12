# OpenDDIL Tactical Telemetry Edge (Demo)

This environment provides a high-fidelity, schema-first edge telemetry pipeline for tactical assets. It handles ingestion, transformation, and real-time anomaly detection.

## 🚀 Key Accomplishments
- **Schema-First Architecture**: Standardized on Protobuf v1 with full unit support (`Quantity`).
- **Resilient Ingress**: Dual-path ingestion (UDP:62040 DIS relayed via socat; HTTP:9999 diagnostic).
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

## 🗺 Tactical Roadmap
Prioritized next steps for the telemetry edge:

1. **Binary PDU Decoder [Sprint 1]**: Implement a Python/Scapy sidecar to decode raw IEEE 1278.1 PDUs into JSON-DIS for the ingest engine.
2. **Entity Type Ontology [Sprint 1]**: A YAML-based lookup table to map DIS Category/Category/Subcategory triples to OpenDDIL Platform URIs.
3. **Dead Reckoning [Sprint 2]**: Implement DR algorithms in the Faust state tables to handle sparse DIS updates (~5Hz).
4. **Egress (OpenDDIL -> DIS) [Deferred]**: Enable bidirectional simulation feedback.

---
**Status**: Production-ready for Windows/Linux dev. Qualified for Linux Edge deployment.