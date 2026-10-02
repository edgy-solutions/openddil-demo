"""Unit tests for egress/pointer.py — RFC 6901 JSON Pointers, stdlib only.

Run: `python -m pytest egress/test_pointer.py -q` from openddil-demo/.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from pointer import PointerError, get, set, tokens  # noqa: E402


# --- tokens / escaping --------------------------------------------------

def test_tokens_of_the_empty_pointer_is_empty():
    assert tokens("") == []


def test_tokens_splits_on_slash():
    assert tokens("/a/b/c") == ["a", "b", "c"]


def test_tilde_one_decodes_to_slash():
    assert tokens("/a~1b") == ["a/b"]


def test_tilde_zero_decodes_to_tilde():
    assert tokens("/a~0b") == ["a~b"]


def test_escape_order_is_tilde_one_then_tilde_zero():
    """Decoding ~0 before ~1 would turn a literal '~1' in the source into
    '/' instead of '~'. The spec's own order matters."""
    assert tokens("/a~01") == ["a~1"]


def test_pointer_not_starting_with_slash_is_malformed():
    with pytest.raises(PointerError):
        tokens("a/b")


# --- get -----------------------------------------------------------------

def test_get_nested_mapping():
    assert get({"a": {"b": 1}}, "/a/b") == 1


def test_get_list_index():
    assert get({"a": ["x", "y"]}, "/a/1") == "y"


def test_get_whole_document_with_empty_pointer():
    doc = {"a": 1}
    assert get(doc, "") is doc


def test_get_escaped_key():
    assert get({"a/b": 1, "c~d": 2}, "/a~1b") == 1
    assert get({"a/b": 1, "c~d": 2}, "/c~0d") == 2


def test_get_missing_without_default_raises():
    with pytest.raises(PointerError):
        get({"a": {}}, "/a/b")


def test_get_missing_with_default_returns_default():
    assert get({"a": {}}, "/a/b", default=None) is None
    assert get({"a": {}}, "/a/b", default="x") == "x"


def test_get_through_a_scalar_is_missing_not_an_error_with_a_default():
    assert get({"a": 1}, "/a/b", default=None) is None


def test_get_out_of_range_list_index_is_missing():
    assert get({"a": [1]}, "/a/5", default=None) is None


# --- set -------------------------------------------------------------------

def test_set_on_an_existing_key():
    doc = {"a": 1}
    set(doc, "/a", 2)
    assert doc == {"a": 2}


def test_set_creates_intermediate_objects():
    doc: dict = {}
    set(doc, "/a/b/c", 5)
    assert doc == {"a": {"b": {"c": 5}}}


def test_set_escaped_key():
    doc: dict = {}
    set(doc, "/a~1b", 1)
    assert doc == {"a/b": 1}


def test_set_does_not_disturb_sibling_keys():
    doc = {"a": {"x": 1}}
    set(doc, "/a/y", 2)
    assert doc == {"a": {"x": 1, "y": 2}}


def test_set_whole_document_pointer_raises():
    with pytest.raises(PointerError):
        set({}, "", 1)


def test_set_through_a_non_object_intermediate_raises():
    with pytest.raises(PointerError):
        set({"a": 1}, "/a/b", 2)
