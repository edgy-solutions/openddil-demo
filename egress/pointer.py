"""pointer.py — RFC 6901 JSON Pointers, stdlib only.

A kind's `x-openddil` block names WHERE in a record its fields live, as
RFC 6901 pointers (e.g. `/what/part`), not as a fixed set of top-level key
names. `gate.py` needs to read a label at a declared pointer and stay
stdlib-only (see its module docstring and the Dockerfile comment on why);
`assembler.py` needs to write a dozen declared pointers into a fresh record.
Both do it through this module rather than hand-rolling dict/list
navigation twice.

Only the two operations either caller needs: `get` (read, with an optional
default for "not there") and `set` (write, creating intermediate objects as
it goes). Nothing here mutates the pointer string itself after `tokens()`
has split and unescaped it once.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

_MISSING = object()


class PointerError(ValueError):
    """A pointer was malformed, or `get` found nothing and no default was
    given. The message names the pointer so a bad declaration is easy to
    find without re-deriving which string failed."""


def tokens(ptr: str) -> list[str]:
    """Split and unescape an RFC 6901 pointer into its reference tokens.

    `""` is the whole-document pointer and yields no tokens. Anything else
    must start with `/`; `~1` decodes to `/` and `~0` to `~`, IN THAT ORDER
    (the spec's own order — decoding `~0` first would turn a literal `~1` in
    the source into `/` instead of `~`)."""
    if ptr == "":
        return []
    if not ptr.startswith("/"):
        raise PointerError(f"not an RFC 6901 pointer (must start with '/'): {ptr!r}")
    return [tok.replace("~1", "/").replace("~0", "~") for tok in ptr.split("/")[1:]]


def get(doc: Any, ptr: str, default: Any = _MISSING) -> Any:
    """Read the value at `ptr`. Returns `default` when given and the
    pointer does not resolve (a missing key, an out-of-range or
    non-numeric list index, or a step through a scalar); raises
    `PointerError` naming the pointer when no default was given."""
    node = doc
    for tok in tokens(ptr):
        if isinstance(node, Mapping) and tok in node:
            node = node[tok]
            continue
        if isinstance(node, Sequence) and not isinstance(node, (str, bytes)):
            try:
                index = int(tok)
            except ValueError:
                index = -1
            if 0 <= index < len(node):
                node = node[index]
                continue
        if default is not _MISSING:
            return default
        raise PointerError(f"{ptr!r} does not resolve against the document")
    return node


def set(doc: dict, ptr: str, value: Any) -> None:
    """Write `value` at `ptr`, creating intermediate dicts as needed.

    `doc` must be a dict (the whole-document pointer `""` cannot be
    assigned a value — there is nothing to replace it in). Each
    intermediate token that does not already name a dict gets one created;
    an intermediate that names something else (a list, a string, a number)
    is a conflict and raises rather than silently overwriting it."""
    toks = tokens(ptr)
    if not toks:
        raise PointerError("cannot set the whole document ('')")
    node = doc
    for tok in toks[:-1]:
        nxt = node.get(tok) if isinstance(node, dict) else None
        if nxt is None:
            nxt = {}
            node[tok] = nxt
        elif not isinstance(nxt, dict):
            raise PointerError(
                f"{ptr!r}: {tok!r} is already a {type(nxt).__name__}, not an object"
            )
        node = nxt
    node[toks[-1]] = value
