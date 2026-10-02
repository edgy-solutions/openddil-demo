# =============================================================================
# openddil-egress — releasability gate + its pane API
# =============================================================================
# ONE IMAGE, TWO COMMANDS. `main.py` is the gate, `pane_api.py` serves the
# pane. They are one image because they are one body of code: both import
# gate.py, and both must agree exactly on what a decision means. Splitting
# them would create two places for that agreement to drift, and the drift
# would show up as a pane that disagrees with the stream it claims to
# describe -- which has already happened once here for a different reason.
# The chart deploys the same image twice with different commands.
#
# WHY THIS IS NOT `FROM projector`
# --------------------------------
# Under compose these processes borrow the projector image and bind-mount
# `./egress` and the generated protos over it. That works there and cannot
# work in a pod: there is no host directory to mount, so whatever the code
# needs has to be IN the image. Building FROM `projector:latest` would have
# been the short path, and it would have meant a digest-pinned image resting
# on a floating base -- the pin would say the build is reproducible while the
# base moved underneath it. So this builds its own runtime, and the pin means
# what it says.
#
# DEPENDENCIES ARE PINNED TO MATCH THE PROJECTOR'S, DELIBERATELY. The protobuf
# range in particular is not a style choice: the stubs under
# openddil-contracts/gen/python are generated code, and a runtime on the wrong
# major version fails at import with a message about the generator rather than
# about the version, which is a slow thing to diagnose at 03:00.
#
# BUILD CONTEXT IS THE WORKSPACE ROOT -- the parent of the checked-out
# openddil-* repos, same as openddil-helm/bundle/Dockerfile. The COPY paths
# below are written from there, because the protos come from a DIFFERENT repo
# than this Dockerfile. Building with `context: openddil-demo/egress` fails on
# the proto COPY with "path not found in build context", and that is the
# intended failure: it is better than an image that silently ships without
# them and dies on first record.
#
#   docker build -f openddil-demo/egress/Dockerfile -t <tag> .
#
# The protos are generated, never committed, so `make -C openddil-contracts
# python` has to have run against this checkout first.
# =============================================================================

# ---------- Stage 1: Builder ----------
FROM python:3.11-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ make librdkafka-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv && uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# confluent-kafka  — the gate's consumer and producer (main.py)
# asyncpg          — the pane's only read path (pane_api.py)
# protobuf         — must match the grpcio-tools major that generated the
#                    stubs in openddil-contracts/gen/python
#
# gate.py itself pulls in nothing: it reaches the PDP over urllib from the
# standard library. That is worth keeping true. The decision path is the part
# that must not fail for an environmental reason, and every dependency it does
# not have is a failure mode it cannot have.
RUN uv pip install --no-cache \
        "confluent-kafka>=2.0.0,<3.0.0" \
        "asyncpg>=0.29.0,<1.0.0" \
        "protobuf>=6.30.0,<7.0.0"

# ---------- Stage 2: Tests ----------
# The gate's 32 unit tests (test_gate.py) plus the CoT adapter's 13
# (test_cot_adapter.py) — 45 total — run against the code that is about to be
# baked in, with no PDP, no broker and no network. The adapter's tests moved
# in here alongside the gate's because `cot_adapter.py` now ships from this
# same image to a cluster (see egress/tak/Dockerfile and
# templates/egress.yaml's `<rel>-egress-cot-adapter-c2` Deployment): the same
# "a failing test cannot produce an image" guarantee the gate already had has
# to cover the adapter too, now that a pod runs it.
#
# THIS STAGE IS NOT OPTIONAL, and the odd-looking COPY in the runtime stage is
# what makes that true. Buildx skips a stage nothing depends on, so a test
# stage that only runs under `--target tester` is a test stage that runs when
# someone remembers -- which is not a gate. The runtime stage copies a file
# that only exists if pytest exited 0, so a failing test cannot produce an
# image at all. It is a release gate for a release gate; it should be the
# hardest thing here to bypass by accident.
FROM builder AS tester
RUN uv pip install --no-cache "pytest>=8.0"
ENV PYTHONPATH=/proto:/app
COPY openddil-contracts/gen/python /proto
COPY openddil-demo/egress /app
WORKDIR /app
RUN python -m pytest test_gate.py test_cot_adapter.py -q && touch /tests-passed

# ---------- Stage 3: Runtime ----------
FROM python:3.11-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        librdkafka1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/proto:/app

# Baked, not mounted. See the header.
COPY openddil-contracts/gen/python /proto
COPY openddil-demo/egress /app

WORKDIR /app

# Carries nothing but the fact that the tests ran. See the tests stage.
COPY --from=tester /tests-passed /tests-passed

# The pane's HTTP port. The gate exposes nothing: it is a pipe between two
# topics and an outward listener on it would be a way in that the design does
# not otherwise have.
EXPOSE 8090/tcp

# The gate is the default because it is the thing that must be running for the
# system to be correct. The pane only describes what the gate already decided,
# and the chart overrides this for that container.
CMD ["python", "/app/main.py"]
