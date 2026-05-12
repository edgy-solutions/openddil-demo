import socket
import json
import time
import copy

# Target: Redpanda Connect UDP Ingress
UDP_IP = "socat-bridge"
UDP_PORT = 62040

def send_udp(payload):
    data = (json.dumps(payload) + "\n").encode('utf-8')
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(data, (UDP_IP, UDP_PORT))
    print(f"UDP Sent: {payload.get('entity_id', 'malformed')} (Seq: {payload.get('pdu_sequence')})")

# 1. Base Payload
base = {
    "entity_id": "LTAMDS-UDP",
    "marking": "BETA",
    "entity_type_label": "RADAR",
    "force_id": 1,
    "dis_entity_id": {"site": 1, "application": 1, "entity": 5},
    "location": {"x": 500.0, "y": 600.0, "z": 700.0},
    "linear_velocity": {"x": 10.0, "y": 10.0, "z": 0.0},
    "orientation": {"psi": 0.0, "theta": 0.0, "phi": 0.0},
    "thermal": {"engine_temp": 100.0, "ambient_temp": 70.0, "coolant_temp": 90.0},
    "power": {"voltage": 24.0, "soc_pct": 100.0},
    "fluids": {"fuel": 500.0},
    "pdu_sequence": 1,
    "timestamp": "2026-05-11T13:00:00Z"
}

# 2. Sequence (100 -> 250 -> 260)
p1 = copy.deepcopy(base)
p1["pdu_sequence"] = 100
p1["thermal"]["engine_temp"] = 100.0

p2 = copy.deepcopy(base)
p2["pdu_sequence"] = 101
p2["thermal"]["engine_temp"] = 250.0

p3 = copy.deepcopy(base)
p3["pdu_sequence"] = 102
p3["thermal"]["engine_temp"] = 260.0

print("Starting UDP DIS-Ingress Test...")
send_udp(p1)
time.sleep(1)
send_udp(p2)
time.sleep(1)
send_udp(p3)
print("UDP Test Sent.")
