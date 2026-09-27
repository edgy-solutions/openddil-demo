"""
Test 55 — no service produces a codec Restate cannot read.

WHY THIS IS A WIRE CHECK AND NOT A GREP. Restate's Kafka ingress is built on a
librdkafka without zstd. One zstd batch kills the consumer task
(`Decompression (codec 0x4) ... Not implemented`); Restate restarts it from its
stored position, hits the same batch, and dies again, forever. It is not a
degraded mode, it is an unkillable restart loop, and it does not log as a
config error.

The chart pins `compression.type=lz4` on the six Restate-subscribed topics,
which works by making the BROKER recompress whatever the client sent. That is a
mitigation downstream of the cause: it holds only while every subscribed topic
keeps the pin, and it silently stops holding the moment a topic's config drifts
back to `producer` or a new subscribed topic is created without it. The cause is
client-side, so this check is client-side.

WHAT IT PROVES, EXACTLY — and no more than this:

  1. Neither service DECLARES zstd. Read out of the service source, so a future
     edit that puts it back goes red here rather than on a cluster.
  2. A record produced with the declared codec, through the same client library
     the services use (confluent_kafka / librdkafka), is STORED with that codec
     on a topic whose `compression.type=producer`. That is the mechanism behind
     the original finding — "store whatever codec the CLIENT chose" — and it is
     what makes (1) load-bearing rather than cosmetic.

WHAT IT DOES NOT PROVE. It does not run cm-service or fusion-service and read
their real output topics. It cannot here: those services produce only when
Restate invokes them, and in compose Restate is down on exactly the zstd
condition this test is about, so `asset-cm-state` carries no record to read.
The stronger check is available wherever those services are actually producing,
and this one is the decomposition that is runnable today: the codec they
declare, plus the broker's treatment of a declared codec, measured rather than
assumed.

A dedicated topic is used rather than a pipeline topic, because producing test
records into `raw-sensor-stream` would feed the mapper and could create assets.
The probe topic is not subscribed by Restate or by anything else.

THE PAYLOAD HAS TO COMPRESS, AND THAT IS NOT A DETAIL. Measured while building
this test: librdkafka does not emit a compressed batch when compression would
not make it smaller. A 20-byte record produced with `compression.type=lz4` is
stored as `none`, and the first version of this test failed on exactly that --
reading "the broker did not preserve my codec" when what actually happened was
"there was nothing worth compressing". So the probe payload is several KB of
compressible bytes, which is the only condition under which a codec assertion
means anything.

The same fact has a consequence beyond this test, and it cuts the reassuring
way: a service sending small messages may store them as `none` whatever it
declares, so the wire cannot prove zstd is absent by sampling small records.
`none` is readable by Restate, so this is safe rather than dangerous -- but it
is the reason (1) is checked at the declaration and not only at the wire.
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    COMPOSE_DIR,
    REDPANDA_SVC,
    _docker_compose_cmd,
    fail_,
    pass_,
    skip_,
)

NAME = "test_55_producer_codec"

# The OUTSIDE listener, advertised as localhost:9093 in docker-compose.yml.
HOST_BROKER = "localhost:9093"

# `compression.type=producer` is the whole point: the broker must store what
# the client sent, not recompress it, or this measures the broker's pin instead
# of the client's choice.
PROBE_TOPIC = "test-producer-codec"

# Codecs Restate's librdkafka can actually decompress. `none` is included
# because it is a legitimate choice, not because it is expected.
ALLOWED = {"none", "gzip", "snappy", "lz4"}
FORBIDDEN = "zstd"

# Big enough, and compressible enough, that every real codec beats the
# uncompressed batch -- otherwise librdkafka ships it uncompressed and the
# stored codec is `none` no matter what was declared. See the docstring.
PROBE_PAYLOAD = b"openddil-codec-probe-" * 256

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVICES = {
    "cm-service": REPO_ROOT / "openddil-cm-service" / "src" / "main.py",
    "fusion-service": REPO_ROOT / "openddil-logistics-fusion-service" / "src" / "main.py",
}

# Matches the conf-dict entry, tolerating the alignment padding both files use.
_DECL = re.compile(r'"compression\.type"\s*:\s*"([a-z0-9]+)"')


def declared_codec(path: Path) -> str:
    """The codec the service asks librdkafka for, read out of its source."""
    if not path.exists():
        skip_(NAME, f"service source not found: {path}")
    m = _DECL.search(path.read_text(encoding="utf-8"))
    if not m:
        # Absent is not innocent: librdkafka's default is `none`, but a
        # producer whose codec is no longer stated is a producer nobody is
        # choosing a codec for, and this test's premise has gone.
        fail_(NAME, f"no compression.type found in {path} — cannot judge the codec")
    return m.group(1)


def _rpk(*args: str, timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(
        _docker_compose_cmd() + ["exec", "-T", REDPANDA_SVC, "rpk", *args],
        cwd=str(COMPOSE_DIR), capture_output=True, text=True, timeout=timeout,
    )


def ensure_probe_topic() -> None:
    """Create the probe topic with producer-preserving compression, idempotently."""
    got = _rpk("topic", "describe", PROBE_TOPIC)
    if got.returncode == 0 and "compression.type" in got.stdout:
        # Already there. Confirm it still preserves the client codec: if
        # somebody pinned it, every assertion below would measure the pin.
        for line in got.stdout.splitlines():
            if line.strip().startswith("compression.type"):
                value = line.split()[1]
                if value != "producer":
                    fail_(NAME,
                          f"{PROBE_TOPIC} has compression.type={value}, not "
                          f"'producer' — this test would measure the broker's "
                          f"recompression instead of the client's codec")
                return
    made = _rpk("topic", "create", PROBE_TOPIC,
                "-p", "1", "-c", "compression.type=producer")
    if made.returncode != 0 and "ALREADY_EXISTS" not in (made.stdout + made.stderr):
        skip_(NAME, f"could not create {PROBE_TOPIC}: "
                    f"{(made.stderr or made.stdout).strip()[:200]}")


def high_watermark() -> int | None:
    got = _rpk("topic", "describe", PROBE_TOPIC, "--print-partitions")
    if got.returncode != 0:
        return None
    for line in got.stdout.splitlines():
        toks = line.split()
        if len(toks) >= 2 and toks[0].isdigit():
            try:
                return int(toks[-1])
            except ValueError:
                return None
    return None


def stored_codec(offset: int) -> str | None:
    """The codec the broker actually stored for the record at `offset`."""
    got = _rpk("topic", "consume", PROBE_TOPIC, "-p", "0",
               "-o", f"{offset}:{offset + 1}",
               "-f", "%a{compression}\n")
    if got.returncode != 0:
        return None
    for line in got.stdout.splitlines():
        line = line.strip()
        if line in ALLOWED or line == FORBIDDEN:
            return line
    return None


def produce_with(codec: str, marker: str) -> bool:
    """Produce one record through librdkafka with `codec`. False if unusable."""
    try:
        from confluent_kafka import Producer
    except ImportError as exc:
        skip_(NAME, f"confluent_kafka unavailable: {exc}")

    # Deliberately the services' own conf shape, minus the parts that do not
    # bear on compression.
    producer = Producer({
        "bootstrap.servers":  HOST_BROKER,
        "acks":               "all",
        "linger.ms":          20,
        "compression.type":   codec,
        "enable.idempotence": True,
    })
    delivered: list[bool] = []
    producer.produce(PROBE_TOPIC, key=b"codec-probe",
                     value=marker.encode() + b":" + PROBE_PAYLOAD,
                     on_delivery=lambda err, _msg: delivered.append(err is None))
    producer.flush(15)
    return bool(delivered) and delivered[0]


def main() -> None:
    # (1) Declared codecs, out of the source.
    declared = {name: declared_codec(path) for name, path in SERVICES.items()}

    bad = {n: c for n, c in declared.items() if c == FORBIDDEN}
    if bad:
        fail_(NAME,
              f"{', '.join(sorted(bad))} declares compression.type={FORBIDDEN} — "
              f"Restate's librdkafka cannot decompress it, and one such batch "
              f"wedges its consumer task permanently")

    unknown = {n: c for n, c in declared.items() if c not in ALLOWED}
    if unknown:
        fail_(NAME, f"unrecognised codec(s), cannot judge safety: {unknown}")

    # (2) The broker stores what the client chose.
    ensure_probe_topic()

    for name, codec in sorted(declared.items()):
        before = high_watermark()
        if before is None:
            skip_(NAME, f"could not read {PROBE_TOPIC} high-watermark — "
                        f"broker unreachable, so the codec is unmeasured")
        marker = f"{name}-{codec}-{uuid.uuid4().hex[:8]}"
        if not produce_with(codec, marker):
            skip_(NAME, f"could not produce to {HOST_BROKER} — "
                        f"codec unmeasured for {name}")

        deadline = time.monotonic() + 15
        after = before
        while time.monotonic() < deadline:
            after = high_watermark() or before
            if after > before:
                break
            time.sleep(0.5)
        if after <= before:
            fail_(NAME, f"produced for {name} but {PROBE_TOPIC} did not advance "
                        f"from {before} — cannot read a codec off a record "
                        f"that is not there")

        got = stored_codec(before)
        if got is None:
            fail_(NAME, f"could not read the stored codec at offset {before} "
                        f"for {name}")
        if got == FORBIDDEN:
            fail_(NAME, f"{name} declares {codec} but the record landed as "
                        f"{FORBIDDEN}")
        if got == "none" and codec != "none":
            fail_(NAME,
                  f"{name} declared {codec} but the record stored as none — "
                  f"either the probe payload stopped being compressible (it is "
                  f"{len(PROBE_PAYLOAD)} bytes of repeating text, so check that "
                  f"first) or the client is not applying its codec at all")
        if got != codec:
            fail_(NAME,
                  f"{name} declared {codec} but the broker stored {got} — the "
                  f"'store what the client chose' premise does not hold on "
                  f"{PROBE_TOPIC}, so the client-side fix is not sufficient "
                  f"and the topic pins are doing the work")

    summary = ", ".join(f"{n}={c}" for n, c in sorted(declared.items()))
    pass_(NAME, f"no service declares {FORBIDDEN}; codec preserved on the wire "
                f"as declared ({summary})")


if __name__ == "__main__":
    main()
