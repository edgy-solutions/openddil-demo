"""kinds.py — the registry of declared record shapes (ADR-0043).

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
