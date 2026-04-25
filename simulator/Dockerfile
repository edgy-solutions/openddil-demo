# Stage 1: Builder
FROM python:3.11-slim AS builder

# Install system build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ make librdkafka-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv and create virtual environment
RUN pip install --no-cache-dir uv && \
    uv venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# 1. Create and isolate all operations into an /app directory
WORKDIR /app

# 2. Copy ONLY the project configuration
COPY pyproject.toml .

# 3. Compile pyproject.toml into a requirements.txt on the fly.
RUN uv pip compile pyproject.toml -o requirements.txt && \
    uv pip install --no-cache -r requirements.txt

# Stage 2: Production
FROM gcr.io/distroless/python3-debian12 AS production

# Copy virtual environment
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONPATH="/app"

WORKDIR /app

# Copy application code
COPY ltamds_simulator.py .

# Run as non-root user
USER nonroot:nonroot

ENTRYPOINT ["/opt/venv/bin/python", "ltamds_simulator.py"]