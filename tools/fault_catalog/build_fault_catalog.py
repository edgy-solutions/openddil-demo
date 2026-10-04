#!/usr/bin/env python3
"""Build a per-platform-variant fault catalog from S1000D fault-isolation
data modules, keyed to CM component slots via a MAP.yaml file.

Usage:
    python build_fault_catalog.py --manual-dir DIR [--manual-dir DIR...] --map MAP.yaml

Prints JSON on stdout, shaped:

    {"variants": {"<variant>": {"manual": "<modelIdentCode>", "codes": [
        {"code": ..., "text": ..., "component": ..., "severity": ..., "dmc": ...},
        ...
    ]}}}

Only data modules whose infoCode starts with "4" (the S1000D fault-isolation
info-code family) and which contain a <faultIsolation> element are read.
XML parsing is stdlib-only (xml.etree.ElementTree); MAP.yaml is parsed with
PyYAML.

A fault code whose assembly has no MAP.yaml entry for its variant is an
error (exit 1, naming the code and assembly) -- never a silent default.
"""
import argparse
import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

import yaml


class MappingError(Exception):
    """Raised when a fault code's manual or assembly has no MAP.yaml entry."""


def _dmcode_tuple(dm_code_el):
    a = dm_code_el.attrib
    return (
        a["modelIdentCode"], a["systemDiffCode"], a["systemCode"],
        a["subSystemCode"], a["subSubSystemCode"], a["assyCode"],
        a["disassyCode"], a["disassyCodeVariant"],
        a["infoCode"], a["infoCodeVariant"], a["itemLocationCode"],
    )


def _dmc_string(dm_code_el):
    mic, sdc, sysc, ssc, sssc, asy, dis, dvar, info, ivar, itemloc = _dmcode_tuple(dm_code_el)
    return f"DMC-{mic}-{sdc}-{sysc}-{ssc}{sssc}-{asy}-{dis}{dvar}-{info}{ivar}-{itemloc}"


def _assembly_key(dm_code_el):
    a = dm_code_el.attrib
    return f"{a['systemCode']}-{a['subSystemCode']}{a['subSubSystemCode']}-{a['assyCode']}"


def iter_fault_isolation_codes(manual_dirs):
    """Yield (model_ident_code, assembly_key, code, text, dmc) for every
    <faultCode> in every S1000D data module under manual_dirs whose infoCode
    starts with "4" and which has a <faultIsolation> element."""
    for manual_dir in manual_dirs:
        for path in sorted(Path(manual_dir).glob("*.xml")):
            try:
                tree = ET.parse(path)
            except ET.ParseError:
                continue
            root = tree.getroot()
            dm_code_el = root.find(".//dmIdent/dmCode")
            if dm_code_el is None:
                continue
            info_code = dm_code_el.attrib.get("infoCode", "")
            if not info_code.startswith("4"):
                continue
            fault_isolation = root.find(".//content/faultIsolation")
            if fault_isolation is None:
                continue
            model_ident_code = dm_code_el.attrib["modelIdentCode"]
            assembly_key = _assembly_key(dm_code_el)
            dmc = _dmc_string(dm_code_el)
            for fault_code_el in fault_isolation.findall(".//faultCode"):
                code = fault_code_el.attrib["faultCodeValue"]
                text_el = fault_code_el.find("faultCodeText")
                text = text_el.text.strip() if text_el is not None and text_el.text else ""
                yield model_ident_code, assembly_key, code, text, dmc


def build_catalog(manual_dirs, map_path):
    with open(map_path, "r", encoding="utf-8") as fh:
        mapping = yaml.safe_load(fh) or {}

    manual_to_variant = {}
    for variant, variant_map in mapping.items():
        manual = (variant_map or {}).get("manual")
        if manual:
            manual_to_variant[manual] = variant

    variants: dict = {}
    for model_ident_code, assembly_key, code, text, dmc in iter_fault_isolation_codes(manual_dirs):
        variant = manual_to_variant.get(model_ident_code)
        if variant is None:
            raise MappingError(
                f"fault code {code} (dmc {dmc}): no platform variant in MAP.yaml "
                f"declares manual {model_ident_code!r}"
            )
        assemblies = (mapping.get(variant) or {}).get("assemblies") or {}
        assembly = assemblies.get(assembly_key)
        if assembly is None:
            raise MappingError(
                f"fault code {code} (dmc {dmc}): assembly {assembly_key!r} has no "
                f"MAP.yaml entry for variant {variant!r}"
            )
        component = assembly["component"]
        severity = assembly["severity"]
        variant_entry = variants.setdefault(variant, {"manual": model_ident_code, "codes": []})
        variant_entry["codes"].append({
            "code": code,
            "text": text,
            "component": component,
            "severity": severity,
            "dmc": dmc,
        })

    for variant_entry in variants.values():
        variant_entry["codes"].sort(key=lambda c: c["code"])

    return {"variants": dict(sorted(variants.items()))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manual-dir", action="append", required=True, dest="manual_dirs",
        help="directory of S1000D data modules; may be repeated",
    )
    parser.add_argument("--map", required=True, dest="map_path", help="MAP.yaml path")
    args = parser.parse_args(argv)

    try:
        catalog = build_catalog(args.manual_dirs, args.map_path)
    except MappingError as exc:
        print(f"build_fault_catalog: {exc}", file=sys.stderr)
        return 1

    json.dump(catalog, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
