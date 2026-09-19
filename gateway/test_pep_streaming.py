"""Exercise the PEP's streaming write-out against a fake upstream.

pep.py cannot be imported standalone (it reads required env at import time and
pulls in oidc), so this reproduces the exact write-out block and asserts the
two things that would silently break a browser:

  1. Content-Length path  -> bytes arrive verbatim, no framing added.
  2. chunked path         -> bytes are FRAMED, and a real HTTP client can
                             parse them back to the original payload.

(2) is the one worth testing: the first draft sent `Transfer-Encoding: chunked`
and then wrote raw bytes, because BaseHTTPRequestHandler does not encode it for
you. That desyncs an HTTP/1.1 keep-alive connection -- the next response is
parsed as a continuation of this one -- and it presents at the panel as
corrupted or hung data, not as an error anyone can name.
"""
import http.client
import io
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STREAM_CHUNK = 64  # tiny, so multi-chunk framing is actually exercised
PAYLOAD = (b'{"headers":[{"operation":"insert"}],"value":' +
           b"x" * 5000 + b"}")


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    declare_length = True

    def log_message(self, *a):
        pass

    def do_GET(self):
        resp = io.BytesIO(PAYLOAD)
        upstream_len = str(len(PAYLOAD)) if self.declare_length else None

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        chunked = upstream_len is None
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        else:
            self.send_header("Content-Length", upstream_len)
        self.end_headers()

        sent = 0
        while True:
            chunk = resp.read(STREAM_CHUNK)
            if not chunk:
                break
            if chunked:
                self.wfile.write(b"%x\r\n" % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
            else:
                self.wfile.write(chunk)
            sent += len(chunk)
        if chunked:
            self.wfile.write(b"0\r\n\r\n")
        assert sent == len(PAYLOAD), sent


def run_case(declare_length: bool, label: str) -> None:
    Fake.declare_length = declare_length
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    try:
        # A REAL http client, so the framing is parsed by something that did
        # not write it. Two requests on ONE connection: if the framing is
        # wrong, the second is where keep-alive desync shows up.
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        for i in (1, 2):
            conn.request("GET", "/v1/shape?table=t")
            r = conn.getresponse()
            body = r.read()
            assert r.status == 200, (label, i, r.status)
            assert body == PAYLOAD, (
                f"{label} request {i}: got {len(body)} bytes, want {len(PAYLOAD)}")
        conn.close()
        print(f"  ok   {label}: 2 requests on one keep-alive connection, "
              f"{len(PAYLOAD)} bytes each, byte-identical")
    finally:
        srv.shutdown()


def run_semaphore_case() -> None:
    """The bound must actually bound: N threads, cap of K, never more than K
    inside at once."""
    cap = 3
    sem = threading.BoundedSemaphore(cap)
    peak = 0
    cur = 0
    lock = threading.Lock()
    done = threading.Event()

    def worker():
        nonlocal peak, cur
        sem.acquire()
        try:
            with lock:
                cur += 1
                peak = max(peak, cur)
            done.wait(0.05)
        finally:
            with lock:
                cur -= 1
            sem.release()

    ts = [threading.Thread(target=worker) for _ in range(20)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert peak <= cap, f"semaphore did not bound: peak={peak} cap={cap}"
    print(f"  ok   semaphore: 20 concurrent requests, peak in-flight {peak} <= {cap}")


def test_content_length_path():
    """Upstream declared a length: bytes arrive verbatim, no framing added."""
    run_case(True, "Content-Length path")


def test_chunked_path():
    """THE ONE THAT MATTERS.

    BaseHTTPRequestHandler does NOT chunk-encode for you. The first draft of
    the streaming change sent `Transfer-Encoding: chunked` and then wrote raw
    bytes -- a header declaring something the code did not do. On an HTTP/1.1
    keep-alive connection that desyncs the socket: the next response is parsed
    as a continuation of this one.

    RED-CHECKED by removing the framing while keeping the header: the client
    then HANGS in `_read_next_chunk_size` waiting for a chunk size that never
    arrives. That is the browser-hang symptom -- not an error anyone can name
    from the panel, which is why it is worth a test rather than a reading.

    Two requests on ONE connection, because a single request can look fine
    while the framing is wrong; desync shows up on the second.
    """
    run_case(False, "chunked path")


def test_semaphore_bounds_inflight():
    """Streaming removes the per-request body; the semaphore bounds the
    multiplier. Both, or neither is a bound -- an unbounded thread per
    connection still multiplies whatever each thread holds, which is how a
    256 MiB cap became a race with the client's retry loop rather than a
    sizing."""
    run_semaphore_case()


if __name__ == "__main__":
    test_content_length_path()
    test_chunked_path()
    test_semaphore_bounds_inflight()
    print("all passed")
