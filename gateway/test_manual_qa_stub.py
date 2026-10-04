"""Tests for the manual question service stand-in (manual_qa_stub.py):
build_reply's own judgment, plus one round trip through the real HTTP
handler to confirm the wiring between them.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

import manual_qa_stub

GROUND_TRUTH = {
    "bit_code": "MRAD-ARR-0417",
    "bit_text": "array module fault, section 3",
    "citations": {
        "fault_isolation": {"dmc": "DMC-ODMRAD-A-34-10-01-00A-421A-A"},
        "ipd": {"dmc": "DMC-ODMRAD-A-34-10-01-00A-941A-A"},
    },
}


def test_question_mentioning_fault_code_cites_fault_isolation_module():
    reply = manual_qa_stub.build_reply("What does MRAD-ARR-0417 mean?",
                                       GROUND_TRUTH, out_of_scope=False)
    assert reply["citations"] == [
        {"dmc": "DMC-ODMRAD-A-34-10-01-00A-421A-A", "step": "Reseat connector"},
    ]
    assert reply["answer"]


def test_question_mentioning_array_module_cites_fault_isolation_module():
    reply = manual_qa_stub.build_reply("tell me about the array module fault",
                                       GROUND_TRUTH, out_of_scope=False)
    assert reply["citations"][0]["dmc"] == "DMC-ODMRAD-A-34-10-01-00A-421A-A"


def test_unrelated_question_gets_empty_citations():
    reply = manual_qa_stub.build_reply("what is the weather today",
                                       GROUND_TRUTH, out_of_scope=False)
    assert reply["citations"] == []
    assert isinstance(reply["answer"], str)


def test_out_of_scope_mode_cites_the_ipd_module_regardless_of_question():
    reply = manual_qa_stub.build_reply("What does MRAD-ARR-0417 mean?",
                                       GROUND_TRUTH, out_of_scope=True)
    assert reply["citations"] == [
        {"dmc": "DMC-ODMRAD-A-34-10-01-00A-941A-A", "title": "illustrated parts data"},
    ]


def test_missing_fixture_data_still_returns_well_formed_empty_reply():
    reply = manual_qa_stub.build_reply("anything", {}, out_of_scope=False)
    assert reply == {"answer": "No matching procedure found for that question.",
                      "citations": []}
    reply = manual_qa_stub.build_reply("anything", {}, out_of_scope=True)
    assert reply == {"answer": "", "citations": []}


def test_http_round_trip_serves_ask():
    server = manual_qa_stub.make_server(host="127.0.0.1", port=0,
                                        fixture_dir="/does/not/exist", out_of_scope=False)
    import threading
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/ask"
        body = json.dumps({"question": "anything", "scope": {"dmcs": []},
                           "on_behalf_of": "op.atl"}).encode()
        req = urllib.request.Request(url, data=body, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            assert r.status == 200
            reply = json.loads(r.read())
        assert reply["citations"] == []

        # An empty body is handled, not a server error -- the handler reads
        # Content-Length (absent here, so zero bytes) and still answers.
        req2 = urllib.request.Request(url, method="POST")
        with urllib.request.urlopen(req2, timeout=5) as r2:
            assert r2.status == 200
    finally:
        server.shutdown()
        server.server_close()


def test_unknown_path_is_404():
    server = manual_qa_stub.make_server(host="127.0.0.1", port=0,
                                        fixture_dir="/does/not/exist", out_of_scope=False)
    import threading
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/nope", method="POST",
                                     data=b"{}")
        try:
            urllib.request.urlopen(req, timeout=5)
            assert False, "expected 404"
        except urllib.error.HTTPError as e:
            assert e.code == 404
    finally:
        server.shutdown()
        server.server_close()
