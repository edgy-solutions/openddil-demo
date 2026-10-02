# =============================================================================
# openddil-tak-server — the stand-in C2 for the lab and clusters
# =============================================================================
# Same taky version (0.10) and the same config file (taky.conf) as compose's
# tak-server service, baked into an image instead of `pip install`-ed at
# container start, so a pod needs no PyPI reach at start time the way the
# compose service does.
#
# taky broadcasts every tracked non-stale `a-*` event to every connected
# client and replays them on connect (router.send_persist) — one TAK server
# is one audience. That is a property of taky itself, not of this image, and
# it is why the chart only ever gives this server's address to readers that
# are meant to see this destination's whole picture (see
# templates/releasability.yaml).
# =============================================================================
FROM python:3.11.9-slim

RUN pip install --no-cache-dir taky==0.10

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin taky \
    && mkdir -p /var/taky \
    && chown -R 10001:10001 /var/taky

COPY taky.conf /etc/taky/taky.conf

USER 10001

EXPOSE 8087/tcp

CMD ["taky", "-c", "/etc/taky/taky.conf", "-l", "info"]
