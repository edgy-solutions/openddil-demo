"""Acceptance checks for the ODMRAD array-module S1000D fixture.

Verifies that the six synthetic data modules are well-formed, that every
dmRef resolves to one of the six, and that GROUND-TRUTH.json accurately
reflects the manual: the BIT fault code and text, every cited DMC, the
illustrated-parts part number and quantity, the planning interval, the
four remediation options and the picture_condition each one carries, and
the dry-run's expected option.

Run with: python check.py (from this directory; needs only lxml)
Exits 0 on pass; on failure, exits non-zero and names the failed check(s).

Set GROUND_TRUTH_PATH to point the script at a different ground-truth
file instead of GROUND-TRUTH.json alongside it.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from lxml import etree

HERE = Path(__file__).resolve().parent

DM_FILES = [
    "DMC-ODMRAD-A-34-10-01-00A-040A-A_001-00_EN-US.xml",
    "DMC-ODMRAD-A-34-10-01-00A-421A-A_001-00_EN-US.xml",
    "DMC-ODMRAD-A-34-10-01-00A-520A-A_001-00_EN-US.xml",
    "DMC-ODMRAD-A-34-10-01-00A-720A-A_001-00_EN-US.xml",
    "DMC-ODMRAD-A-34-10-01-00A-941A-A_001-00_EN-US.xml",
    "DMC-ODMRAD-A-34-10-01-00A-320A-A_001-00_EN-US.xml",
]

SPARE_PN = "ODM-AM-0001"

EXPECTED_PICTURE_CONDITIONS = {
    1: "any",
    2: "any",
    3: "picture.spare.on_hand_here > 0",
    4: "picture.spare.on_hand_here == 0 and picture.nearest_spare is not null",
}

FAILURES: list[str] = []


def fail(msg: str) -> None:
    FAILURES.append(msg)
    print(f"FAIL: {msg}")


def ok(msg: str) -> None:
    print(f"OK:   {msg}")


def dmcode_tuple(dmcode_el) -> tuple:
    """The fields that make a dmCode unique, as a comparable tuple."""
    g = dmcode_el.get
    return (
        g("modelIdentCode", ""), g("systemDiffCode", ""), g("systemCode", ""),
        g("subSystemCode", ""), g("subSubSystemCode", ""), g("assyCode", ""),
        g("disassyCode", ""), g("disassyCodeVariant", ""),
        g("infoCode", ""), g("infoCodeVariant", ""), g("itemLocationCode", ""),
    )


def canonical_str(t: tuple) -> str:
    mic, sdc, sysc, ssc, sssc, asy, dis, dvar, info, ivar, itemloc = t
    return f"{mic}-{sdc}-{sysc}-{ssc}{sssc}-{asy}-{dis}{dvar}-{info}{ivar}-{itemloc}"


def main() -> int:
    # ---------- 1. well-formedness ----------
    trees: dict[str, etree._ElementTree] = {}
    for name in DM_FILES:
        path = HERE / name
        parser = etree.XMLParser(recover=False)
        try:
            trees[name] = etree.parse(str(path), parser)
            ok(f"well-formed: {name}")
        except etree.XMLSyntaxError as exc:
            fail(f"not well-formed: {name}: {exc}")

    if len(trees) != len(DM_FILES):
        print("Aborting further checks: not all files parsed.")
        return _finish()

    # ---------- known DMCs (from each file's own dmIdent/dmCode) ----------
    known_dmcs: dict[tuple, str] = {}
    for name, tree in trees.items():
        dmcode_el = tree.find(".//dmAddress/dmIdent/dmCode")
        if dmcode_el is None:
            fail(f"no dmIdent/dmCode found in {name}")
            continue
        t = dmcode_tuple(dmcode_el)
        known_dmcs[t] = name
        print(f"DMC  {name}: {canonical_str(t)}")

    # ---------- 2. every dmRef resolves to one of the six ----------
    unresolved = 0
    for name, tree in trees.items():
        for dmref in tree.iter("dmRef"):
            dmcode_el = dmref.find(".//dmCode")
            if dmcode_el is None:
                fail(f"{name}: dmRef with no dmCode")
                unresolved += 1
                continue
            t = dmcode_tuple(dmcode_el)
            if t not in known_dmcs:
                fail(f"{name}: dmRef {canonical_str(t)} does not resolve to one of the six DMs")
                unresolved += 1
    if unresolved == 0:
        ok("every dmRef resolves to one of the six DMs")

    # ---------- 3. the ground-truth file, checked against the manual ----------
    gt_path = Path(os.environ.get("GROUND_TRUTH_PATH", str(HERE / "GROUND-TRUTH.json")))
    gt = json.loads(gt_path.read_text(encoding="utf-8"))
    by_dmc = {"DMC-" + canonical_str(t): name for t, name in known_dmcs.items()}

    def cited(dmc: str, what: str) -> str | None:
        if dmc not in by_dmc:
            fail(f"ground truth {what}: {dmc} is not one of the six DMs")
            return None
        return by_dmc[dmc]

    c = gt["citations"]
    fi = cited(c["fault_isolation"]["dmc"], "fault_isolation")
    if fi:
        codes = [e.get("faultCodeValue") for e in trees[fi].iter("faultCode")]
        if gt["bit_code"] in codes:
            ok(f"{gt['bit_code']} is the fault DM's faultCodeValue")
        else:
            fail(f"{gt['bit_code']} not among the fault DM's fault codes {codes}")
        texts = [(e.text or "").strip().lower() for e in trees[fi].iter("faultCodeText")]
        if any(gt["bit_text"].lower() in t for t in texts):
            ok(f"bit_text {gt['bit_text']!r} is in the fault DM")
        else:
            fail(f"bit_text {gt['bit_text']!r} not in the fault DM's text {texts}")
    for dmc in c["remove_install"]["dmc"]:
        cited(dmc, "remove_install")
    ipd = cited(c["ipd"]["dmc"], "ipd")
    if ipd:
        found = None
        for item in trees[ipd].iter("catalogSeqNumber"):
            pns = [(e.text or "").strip() for e in item.iter("partNumber")]
            if c["ipd"]["part_number"] in pns:
                found = (item.findtext(".//reqQuantity") or "").strip()
        if found == str(c["ipd"]["quantity"]):
            ok(f"IPD lists {c['ipd']['part_number']} with quantity {found}")
        else:
            fail(f"IPD quantity for {c['ipd']['part_number']} is {found!r}, "
                 f"ground truth {c['ipd']['quantity']}")
        if SPARE_PN != c["ipd"]["part_number"]:
            fail(f"SPARE_PN {SPARE_PN} != ground truth part {c['ipd']['part_number']}")
        install_text = (HERE / "DMC-ODMRAD-A-34-10-01-00A-720A-A_001-00_EN-US.xml").read_text(encoding="utf-8")
        if SPARE_PN in install_text:
            ok(f"{SPARE_PN} appears in the install DM")
        else:
            fail(f"{SPARE_PN} missing from the install DM")
    plan = cited(c["planning_interval"]["dmc"], "planning_interval")
    if plan:
        values = [(e.text or "").strip() for e in trees[plan].iter("thresholdValue")]
        units = [e.get("thresholdUnitOfMeasure") for e in trees[plan].iter("threshold")]
        want_n, want_unit = c["planning_interval"]["interval"].split(" ", 1)
        if want_n in values and want_unit in units:
            ok(f"planning DM states the interval {c['planning_interval']['interval']} ({units})")
        else:
            fail(f"planning DM interval {values} {units} != ground truth "
                 f"{c['planning_interval']['interval']!r}")
    if len(gt["options"]) != 4:
        fail(f"ground truth has {len(gt['options'])} options, not 4")
    for opt in gt["options"]:
        for dmc in opt["dmcs"]:
            cited(dmc, f"option {opt['n']}")

    # ---------- 4. picture_condition and the dry-run's expected option ----------
    for opt in gt["options"]:
        n = opt["n"]
        want = EXPECTED_PICTURE_CONDITIONS.get(n)
        got = opt.get("picture_condition")
        if want is None:
            fail(f"option {n}: no expected picture_condition defined for this option number")
        elif got != want:
            fail(f"option {n}: picture_condition {got!r} != expected {want!r}")
        else:
            ok(f"option {n}: picture_condition matches {want!r}")

    dry_run = gt.get("dry_run")
    if dry_run is None:
        fail("ground truth has no dry_run")
    elif dry_run.get("expected_option") != 4:
        fail(f"dry_run.expected_option is {dry_run.get('expected_option')!r}, expected 4")
    else:
        ok("dry_run.expected_option is 4")

    return _finish()


def _finish() -> int:
    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed.")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
