"""Stand-in child process for test_stub_adapter.py -- NOT the real entity
simulator (that script belongs to another repo/change and is only ever
run, never imported, from this one). Loops printing a heartbeat until
terminated; ignores all argv so it tolerates whatever STUB_SIM_ARGS a test
passes.
"""
import time

if __name__ == "__main__":
    while True:
        print("heartbeat", flush=True)
        time.sleep(0.2)
