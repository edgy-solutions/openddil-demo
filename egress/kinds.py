"""kinds.py — the registry of declared record shapes (ADR-0043; declarations, ADR-0046).

A "kind" is a name and a JSON Schema: `<Kind>.schema.json` on disk, nothing
more. This module owns the `jsonschema` import so `gate.py` can stay
stdlib-only — see the Dockerfile comment on why the decision path must not
grow a dependency it does not need to run.

A schema that is not valid Draft 2020-12 stops startup rather than being
skipped: a kind registry that silently drops a broken schema is a registry
that is lying about what it validates, and the failure has to name the file
so the fix is immediate rather than a search.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

import jsonschema

SCHEMA_SUFFIX = ".schema.json"

log = logging.getLogger("egress.kinds")

# --- declared time formats ----------------------------------------------------
# jsonschema's own `date-time` / `time` checkers need `rfc3339-validator`, which
# the image does not carry, so they would pass everything. These three are
# stdlib-only; every other format stays an annotation, as before.

FORMAT_MODES = ("off", "report", "enforce")
FORMAT_MODE_ENV = "OPENDDIL_EGRESS_FORMAT_MODE"
TIME_FORMAT_NAMES = frozenset({"date-time", "date", "time"})

_TIME_PART = (r"(\d{2}):(\d{2}):(\d{2})(\.\d+)?"
              r"([Zz]|[+-](\d{2}):(\d{2}))")
# Used with fullmatch (a `$` anchor would accept a trailing newline) and
# re.ASCII (RFC 3339 digits are ASCII; `\d` alone accepts any Unicode digit).
_DATE_TIME_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})[Tt]" + _TIME_PART, re.ASCII)
_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})", re.ASCII)
_TIME_RE = re.compile(_TIME_PART, re.ASCII)


def _real_date(y: str, m: str, d: str) -> bool:
    try:
        datetime.date(int(y), int(m), int(d))
    except ValueError:
        return False
    return True


def _time_ok(groups: tuple) -> bool:
    hh, mm, ss, _frac, _off, oh, om = groups
    if not (int(hh) <= 23 and int(mm) <= 59 and int(ss) <= 60):
        return False
    if oh is not None and not (int(oh) <= 23 and int(om) <= 59):
        return False
    return True


def _check_date_time(instance: Any) -> bool:
    if not isinstance(instance, str):
        return True
    m = _DATE_TIME_RE.fullmatch(instance)
    return bool(m) and _real_date(*m.group(1, 2, 3)) and _time_ok(m.groups()[3:])


def _check_date(instance: Any) -> bool:
    if not isinstance(instance, str):
        return True
    m = _DATE_RE.fullmatch(instance)
    return bool(m) and _real_date(*m.groups())


def _check_time(instance: Any) -> bool:
    if not isinstance(instance, str):
        return True
    m = _TIME_RE.fullmatch(instance)
    return bool(m) and _time_ok(m.groups())


TIME_FORMATS = jsonschema.FormatChecker(formats=())
TIME_FORMATS.checks("date-time")(_check_date_time)
TIME_FORMATS.checks("date")(_check_date)
TIME_FORMATS.checks("time")(_check_time)


def _resolve_mode(format_mode: str | None) -> str:
    if format_mode is None:
        format_mode = os.environ.get(FORMAT_MODE_ENV, "report")
    if format_mode not in FORMAT_MODES:
        raise ValueError(
            f"{FORMAT_MODE_ENV}: {format_mode!r} is not one of {list(FORMAT_MODES)}")
    return format_mode


def _declares_time_format(node: Any) -> bool:
    """True when `"format"` names one of the three checked formats anywhere."""
    if isinstance(node, Mapping):
        if node.get("format") in TIME_FORMAT_NAMES:
            return True
        return any(_declares_time_format(v) for v in node.values())
    if isinstance(node, list):
        return any(_declares_time_format(v) for v in node)
    return False


def _first(errors) -> Any:
    return next(iter(sorted(errors, key=str)), None)


class KindValidator:
    """Callable `record -> str | None`: None when valid, else the first
    structural error's message. The structural check carries no format
    checker, so its result is the same in every mode. When the schema
    declares a checked time format, a second pass counts (report) or refuses
    (enforce) bad values; it never logs the value or the error message."""

    def __init__(self, schema: Mapping, *, kind: str | None, mode: str) -> None:
        self.kind = kind
        self.mode = mode
        self.format_failures: dict[str, int] = {}
        self._counts: dict[tuple, int] = {}
        self._structural = jsonschema.Draft202012Validator(schema)
        self.checks_formats = mode != "off" and _declares_time_format(schema)
        self._formats = (
            jsonschema.Draft202012Validator(schema, format_checker=TIME_FORMATS)
            if self.checks_formats else None)

    def __call__(self, record: Mapping) -> str | None:
        error = _first(self._structural.iter_errors(record))
        result = None if error is None else error.message
        if self._formats is None:
            return result
        format_errors = [e for e in self._formats.iter_errors(record)
                         if e.validator == "format"]
        for e in format_errors:
            fmt = e.validator_value
            self.format_failures[fmt] = self.format_failures.get(fmt, 0) + 1
            key = (self.kind, e.json_path, fmt)
            n = self._counts[key] = self._counts.get(key, 0) + 1
            if _is_power_of_ten(n):
                log.warning("format check (%s): kind=%s path=%s format=%s count=%d",
                            self.mode, self.kind, e.json_path, fmt, n)
        if self.mode == "enforce" and result is None and format_errors:
            return _first(format_errors).message
        return result


def _is_power_of_ten(n: int) -> bool:
    while n >= 10 and n % 10 == 0:
        n //= 10
    return n == 1


def validator_for(schema: Mapping, *, kind: str | None = None,
                  format_mode: str | None = None) -> KindValidator:
    """A callable that checks a record against `schema`.

    Returns `None` when the record is valid, or the first validation
    error's message otherwise. `x-openddil` (or any other key the schema
    carries outside the JSON Schema vocabulary) is simply never consulted by
    `iter_errors` — left alone, not stripped. Time formats: see
    `KindValidator` and `OPENDDIL_EGRESS_FORMAT_MODE`.
    """
    return KindValidator(schema, kind=kind, mode=_resolve_mode(format_mode))


def load_kinds(directory: str | Path, *, format_mode: str | None = None
               ) -> dict[str, Callable[[Mapping], str | None]]:
    """Load every `<Kind>.schema.json` file in `directory`.

    Returns a dict of kind name -> validator. A file that is not a valid
    Draft 2020-12 schema raises, naming the file — this is a startup check,
    not a per-record one.
    """
    mode = _resolve_mode(format_mode)
    directory = Path(directory)
    validators: dict[str, Callable[[Mapping], str | None]] = {}
    for path in sorted(directory.glob(f"*{SCHEMA_SUFFIX}")):
        kind = path.name[: -len(SCHEMA_SUFFIX)]
        try:
            schema = json.loads(path.read_text())
            jsonschema.Draft202012Validator.check_schema(schema)
        except Exception as exc:  # noqa: BLE001 — re-raised naming the file
            raise ValueError(f"{path}: not a valid Draft 2020-12 schema: {exc}") from exc
        validators[kind] = validator_for(schema, kind=kind, format_mode=mode)
    return validators


# --- declarations (ADR-0046, the assembler pass) -----------------------------
# A kind's schema says what shape a record must be; its `x-openddil` block
# says WHERE each field the assembler and the gate care about actually sits
# in that shape, as RFC 6901 pointers (`pointer.py`). Neither gate.py nor
# assembler.py has a hard-coded idea of what a kind's own fields are called —
# that is the whole point of making this declarative rather than another
# per-kind branch in the code.

@dataclass(frozen=True)
class EpisodeDecl:
    """Where the three fields that key an episode live in the record."""

    asset: str
    component: str
    fault_code: str


@dataclass(frozen=True)
class Declarations:
    """One kind's `x-openddil` block, parsed. `key` and `label` are the
    only pointers every kind must declare — a kind the assembler never
    builds (hand-authored, or filled some other way) still needs a `key`
    for de-duplication and a `label` for the gate to enforce against. The
    rest are optional because not every kind carries every one of them; a
    kind the assembler builds needs `owning_tier` and `episode` as well,
    which the assembler's own config check enforces."""

    key: str
    label: str
    owning_tier: str | None = None
    episode: EpisodeDecl | None = None
    observed_at: str | None = None
    sources: str | None = None
    picture: str | None = None
    provenance: str | None = None
    # Where the record says what opened the episode (ADR-0046 §1) — one of
    # the trigger `kind` values the assembler module declares, never a
    # free string the schema would have to vocabulary-check on its own.
    trigger: str | None = None
    # Where the record carries the id of the EPISODE (one per occurrence),
    # distinct from `key`, which then names one EVENT. Absent = the legacy
    # behaviour: `key` carries the episode id and every event of an episode
    # shares it.
    episode_id: str | None = None


def _require_pointer(block: Mapping, name: str) -> str:
    value = block[name]
    if not isinstance(value, str):
        raise TypeError(f"{name!r} must be a JSON pointer string, got {value!r}")
    return value


def _optional_pointer(block: Mapping, name: str) -> str | None:
    """Like `_require_pointer`, but `name` absent from `block` is not an
    error — it just means this kind does not declare that pointer. Present
    and not a string is still refused, same as a required pointer."""
    if name not in block:
        return None
    return _require_pointer(block, name)


def load_declarations(directory: str | Path) -> dict[str, "Declarations"]:
    """Load every kind's `x-openddil` declarations block.

    One file read per kind, independent of `load_kinds` — this function
    only ever looks at the `x-openddil` key, never at the JSON Schema
    vocabulary around it. A schema with no `x-openddil` block has no
    declarations and is absent from the result (the gate then reads the
    label where it always has). A block missing `key` or `label`, an
    `episode` missing any of `{asset,component,fault_code}`, or a pointer
    that is not a string, raises naming the file: this is a startup check,
    and a kind the gate or assembler cannot actually use must not be
    allowed to load silently and fail later on the first record.
    """
    directory = Path(directory)
    out: dict[str, Declarations] = {}
    for path in sorted(directory.glob(f"*{SCHEMA_SUFFIX}")):
        kind = path.name[: -len(SCHEMA_SUFFIX)]
        try:
            schema = json.loads(path.read_text())
            if "x-openddil" not in schema:
                continue
            block = schema["x-openddil"]
            if not isinstance(block, Mapping):
                raise TypeError("'x-openddil' must be a JSON object")
            episode = None
            if "episode" in block:
                episode_block = block["episode"]
                if not isinstance(episode_block, Mapping):
                    raise TypeError("'x-openddil.episode' must be a JSON object")
                episode = EpisodeDecl(
                    asset=_require_pointer(episode_block, "asset"),
                    component=_require_pointer(episode_block, "component"),
                    fault_code=_require_pointer(episode_block, "fault_code"),
                )
            declarations = Declarations(
                key=_require_pointer(block, "key"),
                label=_require_pointer(block, "label"),
                owning_tier=(_require_pointer(block, "owning_tier")
                             if "owning_tier" in block else None),
                episode=episode,
                observed_at=block.get("observed_at"),
                sources=block.get("sources"),
                picture=block.get("picture"),
                provenance=_optional_pointer(block, "provenance"),
                trigger=_optional_pointer(block, "trigger"),
                episode_id=_optional_pointer(block, "episode_id"),
            )
        except Exception as exc:  # noqa: BLE001 — re-raised naming the file
            raise ValueError(
                f"{path}: malformed 'x-openddil' declarations block: {exc}"
            ) from exc
        out[kind] = declarations
    return out
