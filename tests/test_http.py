import urllib.request
import json
import time
import copy

URL = "http://redpanda-connect:9999/"

def send_payload(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(URL, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req) as f:
            print(f"Sent: {payload.get('entity_id', 'malformed')} (Seq: {payload.get('pdu_sequence')}) -> Status: {f.getcode()}")
    except Exception as e:
        print(f"Failed to send: {e}")

# 1. Base Payload
base = {
    "entity_id": "LTAMDS-04",
    "marking": "ALPHA",
    "entity_type_label": "RADAR",
    "force_id": 1,
    "dis_entity_id": {"site": 1, "application": 1, "entity": 4},
    "location": {"x": 100.0, "y": 200.0, "z": 300.0},
    "linear_velocity": {"x": 0.0, "y": 0.0, "z": 0.0},
    "orientation": {"psi": 0.0, "theta": 0.0, "phi": 0.0},
    "thermal": {"engine_temp": 100.0, "ambient_temp": 70.0, "coolant_temp": 90.0},
    "power": {"voltage": 24.0, "soc_pct": 100.0},
    "fluids": {"fuel": 500.0},
    "pdu_sequence": 1,
    "timestamp": "2026-05-11T12:00:00Z"
}

# 2. Malformed
malformed = {"garbage": "data"}

# 3. Step 1: Normal
p1 = copy.deepcopy(base)
p1["pdu_sequence"] = 1
p1["thermal"]["engine_temp"] = 100.0

# 4. Step 2: Jump (High rate)
p2 = copy.deepcopy(base)
p2["pdu_sequence"] = 2
p2["thermal"]["engine_temp"] = 250.0

# 5. Step 3: Continued High (Sustained)
p3 = copy.deepcopy(base)
p3["pdu_sequence"] = 3
p3["thermal"]["engine_temp"] = 260.0

print("Starting E2E Test (Take 5)...")
send_payload(p1)
time.sleep(1)
send_payload(malformed)
time.sleep(1)
send_payload(p2)
time.sleep(1)
send_payload(p3)
print("E2E Test Sent.")
