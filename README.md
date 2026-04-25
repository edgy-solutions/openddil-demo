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

## How to Run the Demo

### 1. Start the Infrastructure
Navigate to the root of the `openddil-demo` repository and start the core infrastructure (Redpanda, Postgres, Toxiproxy) using Docker Compose:
```bash
docker-compose up -d
```

### 2. Start the Sensor Simulator
In a separate terminal, navigate to the `simulator` directory, install dependencies, and run the LTAMDS simulator:
```bash
cd simulator
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt # or uv pip install . if pyproject.toml is used
python ltamds_simulator.py
```
*(This will start pumping nominal 10Hz telemetry to the Edge Redpanda broker).*

### 3. Start the Tactical Agents
In a separate terminal, navigate to the `openddil-tactical-agents` repository and start the Faust and Restate agents:
```bash
# Start Faust Edge Agent
cd openddil-tactical-agents/edge
faust -A faust_edge worker -l info

# Start Restate Hub Agent (ensure Restate server is running)
cd openddil-tactical-agents/hub
python restate_hub.py
```

### 4. Start the React Dashboards
In a separate terminal, navigate to the `frontend` directory, install dependencies, and start the Vite development server:
```bash
cd frontend
npm install
npm run dev
```

### 5. Execute the "Hero" Scenario
1. Open your browser to the local Vite URL (e.g., `http://localhost:5173`).
2. Use the top navigation bar to open **EDGE**, **REGIONAL**, **HQ**, and **DDIL CONTROLLER** in separate browser windows.
3. Observe the nominal data flowing across all dashboards.
4. Go to the **DDIL CONTROLLER** and aggressively lower the bandwidth or toggle the `HQ WAN` switch off. Observe the HQ dashboard freeze while the Edge remains responsive.
5. Trigger the anomaly by sending a POST request to the simulator:
   ```bash
   curl -X POST http://localhost:8000/trigger-anomaly
   ```
6. Watch the Edge dashboard detect the anomaly, throttle power, and log the event.
7. Go back to the **DDIL CONTROLLER** and restore the network link. Watch the buffered data flush to HQ, instantly updating the global digital twin and injecting the automated Work Order.