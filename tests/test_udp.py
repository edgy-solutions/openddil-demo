import socket
import json
import time

UDP_IP = "127.0.0.0" # Windows might route localhost UDP weirdly, let's use 127.0.0.1
UDP_PORT = 62040

def send_payload(payload):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(json.dumps(payload).encode(), ("redpanda-connect", UDP_PORT))
    print(f"Sent: {payload['entity_id'] if 'entity_id' in payload else 'malformed'}")

# 1. Normal Payload
normal = {
    "entity_id": "LTAMDS-04",
    "marking": "ALPHA",
    "entity_type_label": "RADAR",
    "force_id": 1,
    "dis_entity_id": {"site": 1, "application": 1, "entity": 4},
    "location": {"x": 100.0, "y": 200.0, "z": 300.0},
    "linear_velocity": {"x": 0.0, "y": 0.0, "z": 0.0},
    "orientation": {"psi": 0.0, "theta": 0.0, "phi": 0.0},
    "thermal": {
        "engine_temp": 100.0, # ~310K
        "ambient_temp": 70.0, # ~294K
        "coolant_temp": 90.0
    },
    "power": {"voltage": 24.0, "soc_pct": 100.0},
    "fluids": {"fuel": 500.0},
    "pdu_sequence": 1,
    "timestamp": "2026-05-11T12:00:00Z"
}

# 2. Thermal Runaway Payload (Component - Ambient > 80K and rising)
# Current ambient ~294K. Runaway requires component > 374K. 
# 374K is approx 213F. Let's send 250F.
runaway_1 = dict(normal)
runaway_1["thermal"] = dict(normal["thermal"])
runaway_1["thermal"]["engine_temp"] = 250.0 

runaway_2 = dict(runaway_1)
runaway_2["thermal"] = dict(runaway_1["thermal"])
runaway_2["thermal"]["engine_temp"] = 260.0 # Rising

# 3. Malformed Payload
malformed = {
    "garbage": "data",
    "no_id": True
}

if __name__ == "__main__":
    send_payload(normal)
    time.sleep(1)
    
    # Send malformed
    send_payload(malformed)
    time.sleep(1)
    
    # Trigger thermal runaway
    send_payload(runaway_1)
    time.sleep(1)
    send_payload(runaway_2)
