# OpenDDIL Demo - Agents Documentation

## Role and Context
You are an AI agent working on the `openddil-demo` repository. This repository handles the orchestration, simulation, and frontend UI for the OpenDDIL "Hero" scenario.

## Core Directives
1. **Frontend Tech Stack**:
   - React (Vite), Tailwind CSS (strict Dark Mode).
   - UI Components: Tremor for metrics/charts.
   - 3D Visualization: `@react-three/fiber` and `@react-three/drei`.
   - Aesthetic: High-stakes, Tier-1 military display. Stark contrasts, slate/zinc backgrounds, neon accents (emerald/nominal, amber/degraded, rose/critical). Sharp edges only.

2. **Simulation & Orchestration**:
   - `docker-compose.yml` sets up `redpanda-edge`, `redpanda-hq`, `postgres-hq`, `electric-sync`, `toxiproxy`, and `redpanda-connect`.
   - Network simulation is driven by Toxiproxy (port 8474 for proxy, 8475 for control API).
   - The LTAMDS Simulator generates 10Hz telemetry and exposes an anomaly trigger endpoint.

3. **Backend Agents**:
   - The actual Faust and Restate agents processing the data live in the `openddil-tactical-agents` repository. Do not recreate them here.

4. **Docker Compose split — base = images only, override = builds**:
   - `docker-compose.yml` (base) MUST contain ONLY `image:` references
     pulled from a registry (ghcr.io, docker.io, etc.). It MUST NOT
     contain any `build:` directives, source bind-mounts, or
     `pull_policy: build`. A customer or CI runner with only this file
     should be able to `docker compose -f docker-compose.yml up` and
     get a working stack from registry images alone.
   - `docker-compose.override.yml` owns every `build:` block, every
     hot-reload source mount, and `pull_policy: build`. Docker Compose
     auto-merges this file when present, so `docker compose up` from
     this directory still does the dev-friendly thing.
   - **When adding a new service**:
     1. Publish the image to `ghcr.io/edgy-solutions/openddil/<service>:latest`.
     2. Reference it via `image:` in `docker-compose.yml`.
     3. Put the matching `build:` block (and any source mounts) into
        `docker-compose.override.yml`.
   - **Never** add a `build:` directive to `docker-compose.yml`.
     If a service requires local builds for the demo to work at all,
     publish an image first, then reference that image.
   - **Customer-encumbered services** never live in either of these
     files. They live in `openddil-customer-bundle/docker-compose.customer.yml`
     and are layered on top via `-f` flags.