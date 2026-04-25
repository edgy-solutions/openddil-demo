# OpenDDIL Demo (The "Hero" Scenario)

This repository contains the proof-of-concept orchestration and UI layer for the OpenDDIL architecture.

## Overview
It simulates a DDIL environment processing high-velocity sensor telemetry from an LTAMDS radar, detecting anomalies autonomously at the edge, and synchronizing with national enterprise logistics systems (RTX EAGLE/ALCS) over highly unstable satellite links.

## Components
- **Frontend Dashboards**: React/Vite applications for Edge, Regional, and HQ Command Centers (using Tailwind, Tremor, and React Three Fiber).
- **DDIL Controller**: A React UI to dynamically control Toxiproxy and simulate network degradation (Bandwidth, Jitter, Stutter).
- **Demo Orchestration**: `docker-compose.yml` to wire up Redpanda, PostgreSQL, ElectricSQL, Toxiproxy, and Redpanda Connect.
- **LTAMDS Simulator**: A Python script (`simulator/ltamds_simulator.py`) to generate fake sensor data and trigger anomalies.

## The "Hero" Scenario
1. System is nominal. Data flows from Edge to HQ.
2. Toggle Toxiproxy to kill the satellite link. HQ freezes.
3. Inject a simulated "Coolant Pressure Drop" anomaly at the Edge.
4. Edge Faust detects it -> Edge Restate throttles radar power to 85% and stages a resupply work order. Edge UI updates dynamically; HQ remains blind.
5. Toggle Toxiproxy to restore the link. The Redpanda buffer flushes. HQ instantly updates the digital twin, and the automated Work Order appears in the ALCS enterprise queue.