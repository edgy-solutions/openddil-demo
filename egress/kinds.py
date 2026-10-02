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

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

import jsonschema

SCHEMA_SUFFIX = ".schema.json"


def validator_for(schema: Mapping) -> Callable[[Mapping], str | None]:
    """A callable that checks a record against `schema`.

    Returns `None` when the record is valid, or the first validation
    error's message otherwise. `x-openddil` (or any other key the schema
    carries outside the JSON Schema vocabulary) is simply never consulted by
    `iter_errors` — left alone, not stripped.
    """
    validator = jsonschema.Draft202012Validator(schema)

    def validate(record: Mapping) -> str | None:
        error = next(iter(sorted(validator.iter_errors(record), key=str)), None)
        return None if error is None else error.message

    return validate


def load_kinds(directory: str | Path) -> dict[str, Callable[[Mapping], str | None]]:
    """Load every `<Kind>.schema.json` file in `directory`.

    Returns a dict of kind name -> validator. A file that is not a valid
    Draft 2020-12 schema raises, naming the file — this is a startup check,
    not a per-record one.
    """
    directory = Path(directory)
    validators: dict[str, Callable[[Mapping], str | None]] = {}
    for path in sorted(directory.glob(f"*{SCHEMA_SUFFIX}")):
        kind = path.name[: -len(SCHEMA_SUFFIX)]
        try:
            schema = json.loads(path.read_text())
            jsonschema.Draft202012Validator.check_schema(schema)
        except Exception as exc:  # noqa: BLE001 — re-raised naming the file
            raise ValueError(f"{path}: not a valid Draft 2020-12 schema: {exc}") from exc
        validators[kind] = validator_for(schema)
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


def _require_pointer(block: Mapping, name: str) -> str:
    value = block[name]
    if not isinstance(value, str):
        raise TypeError(f"{name!r} must be a JSON pointer string, got {value!r}")
    return value


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
            )
        except Exception as exc:  # noqa: BLE001 — re-raised naming the file
            raise ValueError(
                f"{path}: malformed 'x-openddil' declarations block: {exc}"
            ) from exc
        out[kind] = declarations
    return out
