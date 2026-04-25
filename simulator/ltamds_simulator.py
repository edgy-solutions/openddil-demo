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
KAFKA_BROKER = "localhost:9093" # Use outside port if running locally outside docker
TOPIC = "raw-sensor-stream"

# State
simulation_state = {
    "anomaly_active": False,
    "anomaly_start_time": 0
}

def get_kafka_producer():
    return Producer({
        'bootstrap.servers': KAFKA_BROKER,
        'client.id': 'ltamds-simulator'
    })

async def simulation_loop():
    producer = get_kafka_producer()
    
    while True:
        current_time = time.time()
        
        if simulation_state["anomaly_active"]:
            elapsed = current_time - simulation_state["anomaly_start_time"]
            if elapsed < 10:
                # Spike temp, drop pressure over 10s
                core_temp = 32.0 + (elapsed * 2.3) # up to 55
                coolant_pressure = 120.0 - (elapsed * 4.0) # down to 80
            else:
                core_temp = 55.0 + random.uniform(-1.0, 1.0)
                coolant_pressure = 80.0 + random.uniform(-2.0, 2.0)
        else:
            core_temp = 32.0 + random.uniform(-0.5, 0.5)
            coolant_pressure = 120.0 + random.uniform(-1.0, 1.0)
            
        payload = {
            "device_id": "LTAMDS-04",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "core_temp": round(core_temp, 2),
            "coolant_pressure": round(coolant_pressure, 2)
        }
        
        try:
            producer.produce(
                TOPIC,
                key="LTAMDS-04".encode('utf-8'),
                value=json.dumps(payload).encode('utf-8')
            )
            producer.poll(0)
        except Exception as e:
            print(f"Failed to produce: {e}")
            
        await asyncio.sleep(0.1) # 10Hz

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(simulation_loop())

@app.post("/trigger-anomaly")
async def trigger_anomaly():
    simulation_state["anomaly_active"] = True
    simulation_state["anomaly_start_time"] = time.time()
    return {"status": "anomaly_triggered", "message": "Coolant pressure drop simulated"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
