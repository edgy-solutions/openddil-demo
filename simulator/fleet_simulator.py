import os
import asyncio
import json
import time
from datetime import datetime, timezone
import random
from fastapi import FastAPI
import uvicorn
from confluent_kafka import Producer

app = FastAPI()

# Configuration
KAFKA_BROKER = os.environ.get("KAFKA_BROKER", "localhost:9093")
SENSOR_TOPIC = "raw-sensor-stream"
REGISTRY_TOPIC = "asset-registry"

ASSETS = {
    "LTAMDS-04": {"type": "RADAR", "node_id": "FOB-ALPHA", "base_telemetry": {"core_temp": 42.1, "coolant_pressure": 118.5}},
    "STRYKER-DE-09": {"type": "LASER_SHORAD", "node_id": "FOB-ALPHA", "base_telemetry": {"cavity_temp": 85.0, "pump_rpm": 4500}},
    "HIMARS-ALPHA": {"type": "ARTILLERY", "node_id": "OUTPOST-ECHO", "base_telemetry": {"hydraulic_pressure": 3000, "elevation_angle": 45.0}},
    "GHOST-UGV-1": {"type": "QUADRUPED", "node_id": "MOBILE-CONVOY-7", "base_telemetry": {"joint_torque": 12.5, "battery_discharge": 5.2}}
}

# State
simulation_state = {
    "LTAMDS-04": {"anomaly_active": False, "anomaly_start_time": 0},
    "STRYKER-DE-09": {"anomaly_active": False, "anomaly_start_time": 0},
    "HIMARS-ALPHA": {"anomaly_active": False, "anomaly_start_time": 0},
    "GHOST-UGV-1": {"anomaly_active": False, "anomaly_start_time": 0}
}

def get_kafka_producer():
    return Producer({
        'bootstrap.servers': KAFKA_BROKER,
        'client.id': 'fleet-simulator'
    })

def generate_telemetry(asset_id, current_time):
    asset = ASSETS[asset_id]
    state = simulation_state[asset_id]
    base = asset["base_telemetry"]
    
    telemetry = {}
    
    if state["anomaly_active"]:
        elapsed = current_time - state["anomaly_start_time"]
        
        if asset_id == "LTAMDS-04":
            if elapsed < 10:
                telemetry["core_temp"] = base["core_temp"] + (elapsed * 2.3)
                telemetry["coolant_pressure"] = base["coolant_pressure"] - (elapsed * 4.0)
            else:
                telemetry["core_temp"] = base["core_temp"] + 23.0 + random.uniform(-1.0, 1.0)
                telemetry["coolant_pressure"] = base["coolant_pressure"] - 40.0 + random.uniform(-2.0, 2.0)
        
        elif asset_id == "STRYKER-DE-09":
            if elapsed < 10:
                telemetry["cavity_temp"] = base["cavity_temp"] + (elapsed * 5.0)
                telemetry["pump_rpm"] = base["pump_rpm"] + (elapsed * 100)
            else:
                telemetry["cavity_temp"] = base["cavity_temp"] + 50.0 + random.uniform(-2.0, 2.0)
                telemetry["pump_rpm"] = base["pump_rpm"] + 1000 + random.uniform(-50, 50)
                
        elif asset_id == "HIMARS-ALPHA":
            if elapsed < 10:
                telemetry["hydraulic_pressure"] = base["hydraulic_pressure"] - (elapsed * 100)
                telemetry["elevation_angle"] = base["elevation_angle"]
            else:
                telemetry["hydraulic_pressure"] = base["hydraulic_pressure"] - 1000 + random.uniform(-50, 50)
                telemetry["elevation_angle"] = base["elevation_angle"]
                
        elif asset_id == "GHOST-UGV-1":
            if elapsed < 10:
                telemetry["joint_torque"] = base["joint_torque"] + (elapsed * 2.0)
                telemetry["battery_discharge"] = base["battery_discharge"] + (elapsed * 1.0)
            else:
                telemetry["joint_torque"] = base["joint_torque"] + 20.0 + random.uniform(-1.0, 1.0)
                telemetry["battery_discharge"] = base["battery_discharge"] + 10.0 + random.uniform(-0.5, 0.5)
    else:
        for k, v in base.items():
            telemetry[k] = v + random.uniform(-v * 0.02, v * 0.02) # 2% noise
            
    # Round all values
    for k in telemetry:
        telemetry[k] = round(telemetry[k], 2)
        
    return telemetry

async def registry_loop():
    producer = get_kafka_producer()
    while True:
        for asset_id, asset in ASSETS.items():
            payload = {
                "asset_id": asset_id,
                "type": asset["type"],
                "node_id": asset["node_id"],
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            try:
                producer.produce(
                    REGISTRY_TOPIC,
                    key=asset_id.encode('utf-8'),
                    value=json.dumps(payload).encode('utf-8')
                )
            except Exception as e:
                print(f"Failed to produce registry: {e}")
        try:
            producer.poll(0)
        except Exception:
            pass
        await asyncio.sleep(10)

async def simulation_loop():
    producer = get_kafka_producer()
    
    while True:
        current_time = time.time()
        
        for asset_id, asset in ASSETS.items():
            telemetry = generate_telemetry(asset_id, current_time)
            
            # Use device_id for backward compatibility with Faust
            payload = {
                "asset_id": asset_id,
                "device_id": asset_id,
                "type": asset["type"],
                "node_id": asset["node_id"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
                **telemetry
            }
            
            try:
                producer.produce(
                    SENSOR_TOPIC,
                    key=asset_id.encode('utf-8'),
                    value=json.dumps(payload).encode('utf-8')
                )
            except Exception as e:
                print(f"Failed to produce telemetry: {e}")
                
        try:
            producer.poll(0)
        except Exception:
            pass
            
        await asyncio.sleep(0.1) # 10Hz

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(simulation_loop())
    asyncio.create_task(registry_loop())

@app.post("/trigger-anomaly/{asset_id}")
async def trigger_anomaly(asset_id: str):
    if asset_id in simulation_state:
        simulation_state[asset_id]["anomaly_active"] = True
        simulation_state[asset_id]["anomaly_start_time"] = time.time()
        return {"status": "anomaly_triggered", "asset": asset_id}
    return {"status": "error", "message": "Asset not found"}, 404

@app.post("/clear-anomaly/{asset_id}")
async def clear_anomaly(asset_id: str):
    if asset_id in simulation_state:
        simulation_state[asset_id]["anomaly_active"] = False
        return {"status": "anomaly_cleared", "asset": asset_id}
    return {"status": "error", "message": "Asset not found"}, 404

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
