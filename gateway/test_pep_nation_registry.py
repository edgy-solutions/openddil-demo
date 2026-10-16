"""The nations registry read from the releasability file (colour palette).

Parser only; /auth/me serves its result verbatim as `nation_registry`.
Everything here is synthetic: invented nations ATL and BDR.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest


@pytest.fixture
def pep(monkeypatch, tmp_path):
    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:1"
    os.environ["OPENDDIL_TOPAZ_URL"] = "http://127.0.0.1:1"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415

    def write(text):
        f = tmp_path / "releasability.yaml"
        f.write_text(text, encoding="utf-8")
        monkeypatch.setattr(pep, "RELEASABILITY_FILE", str(f))
        return pep._deployment_nation_registry()

    pep.write = write
    return pep


def test_block_style_with_hash_in_quotes(pep):
    got = pep.write('# c\nnations:\n  ATL:\n    name: Atlantia\n    color: "#38bdf8"  # sky\n'
                    '  BDR:\n    name: Borduria\n    color: "#A78BFA"\ndefault_originator_nation: null\n')
    assert got == [{"code": "ATL", "name": "Atlantia", "color": "#38bdf8"},
                   {"code": "BDR", "name": "Borduria", "color": "#a78bfa"}]
    assert pep._deployment_nations() == ["ATL", "BDR"]


def test_flow_style(pep):
    got = pep.write('nations:\n  BDR: {name: Borduria, color: "#a78bfa"}\n'
                    '  ATL: {name: "Atlantia, North", color: \'#38bdf8\'}  # c\nx: 1\n')
    assert got == [{"code": "BDR", "name": "Borduria", "color": "#a78bfa"},
                   {"code": "ATL", "name": "Atlantia, North", "color": "#38bdf8"}]


def test_bad_or_missing_colour_is_null(pep, caplog):
    got = pep.write('nations:\n  ATL:\n    name: Atlantia\n    color: sky\n'
                    '  BDR: {name: Borduria, color: "#abc"}\n')
    assert [e["color"] for e in got] == [None, None]
    assert [e["name"] for e in got] == ["Atlantia", "Borduria"]
    assert "not #rrggbb" in caplog.text
    assert pep.write("nations:\n  ATL:\n    name: Atlantia\n")[0]["color"] is None


def test_missing_file(pep, monkeypatch, tmp_path):
    monkeypatch.setattr(pep, "RELEASABILITY_FILE", str(tmp_path / "absent.yaml"))
    assert pep._deployment_nation_registry() == []
    assert pep._deployment_nations() == []


def test_shipped_file_has_both_nations(pep, monkeypatch):
    monkeypatch.setattr(pep, "RELEASABILITY_FILE",
                        str(Path(__file__).resolve().parent.parent / "ontology" / "releasability.yaml"))
    got = pep._deployment_nation_registry()
    assert [e["code"] for e in got] == ["ATL", "BDR"]
    assert all(e["color"] for e in got)
