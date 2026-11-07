# test_udp_final.py is a manual script, not a test: it sends UDP to socat-bridge at import time, so it only runs
# on the compose network (README "Truth Serum"). Collecting it anywhere else fails the whole tests/ run.
collect_ignore = ["test_udp_final.py"]
