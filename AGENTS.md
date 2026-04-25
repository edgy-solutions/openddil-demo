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