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
import re
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

IPD_FILE = "DMC-ODMRAD-A-34-10-01-00A-941A-A_001-00_EN-US.xml"
FAULT_FILE = "DMC-ODMRAD-A-34-10-01-00A-421A-A_001-00_EN-US.xml"

SPARE_PN = "ODM-AM-0001"

SVG_NS = "{http://www.w3.org/2000/svg}"

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

    # ---------- (a) every graphic/@infoEntityIdent has a well-formed <ICN>.svg ----------
    icns: set[str] = set()
    for name in DM_FILES:
        for g in trees[name].iter("graphic"):
            icn = g.get("infoEntityIdent")
            if icn:
                icns.add(icn)

    svg_trees: dict[str, etree._ElementTree] = {}
    for icn in sorted(icns):
        svg_path = HERE / f"{icn}.svg"
        if not svg_path.exists():
            fail(f"(a) no SVG for ICN {icn}: expected {svg_path.name}")
            continue
        try:
            svg_trees[icn] = etree.parse(str(svg_path), etree.XMLParser(recover=False))
            ok(f"(a) {svg_path.name} exists and is well-formed XML")
        except etree.XMLSyntaxError as exc:
            fail(f"(a) {svg_path.name} is not well-formed XML: {exc}")

    # ---------- (b) the SVG is inert ----------
    for icn, svg_tree in svg_trees.items():
        bad = False
        root = svg_tree.getroot()
        for el in root.iter():
            if not isinstance(el.tag, str):
                continue
            local = etree.QName(el).localname
            if local in ("script", "foreignObject"):
                fail(f"(b) {icn}.svg: contains <{local}>")
                bad = True
            for attr in el.attrib:
                attr_local = etree.QName(attr).localname
                if attr_local.lower().startswith("on"):
                    fail(f"(b) {icn}.svg: <{local}> has event attribute {attr}")
                    bad = True
            for href_attr in ("href", "{http://www.w3.org/1999/xlink}href"):
                val = el.get(href_attr)
                if val is not None and not val.startswith("#"):
                    fail(f"(b) {icn}.svg: <{local}> href {val!r} does not start with #")
                    bad = True
        if not bad:
            ok(f"(b) {icn}.svg is inert (no script/foreignObject/on*, hrefs local-only)")

    # ---------- (c) SVG hotspots and 941 hotspots, one for one, joined both ways ----------
    ipd_graphic = trees[IPD_FILE].find(".//graphic")
    icn_941 = ipd_graphic.get("infoEntityIdent") if ipd_graphic is not None else None
    svg_941 = svg_trees.get(icn_941) if icn_941 else None

    if svg_941 is None:
        fail(f"(c) cannot check hotspots: no SVG loaded for 941's ICN {icn_941!r}")
    else:
        svg_root = svg_941.getroot()
        svg_hotspots: dict[str, str | None] = {}
        for g in svg_root.iter(f"{SVG_NS}g"):
            classes = (g.get("class") or "").split()
            if "hotspot" in classes and g.get("id"):
                svg_hotspots[g.get("id")] = g.get("data-ipd-item")

        ipd_hotspots = {
            h.get("applicationStructureIdent"): h
            for h in trees[IPD_FILE].iter("hotspot")
            if h.get("applicationStructureIdent")
        }

        svg_ids = set(svg_hotspots)
        ipd_ids = set(ipd_hotspots)
        missing_from_svg = ipd_ids - svg_ids
        missing_from_ipd = svg_ids - ipd_ids
        if missing_from_svg:
            fail(f"(c) hotspot ids missing from the SVG (present in 941 hotspots): {sorted(missing_from_svg)}")
        if missing_from_ipd:
            fail(f"(c) hotspot ids missing from 941 hotspots (present in the SVG): {sorted(missing_from_ipd)}")
        if not missing_from_svg and not missing_from_ipd:
            ok("(c) SVG hotspot ids and 941 hotspot/@applicationStructureIdent match 1:1")

        catalog_items = {
            csn.get("item")
            for csn in trees[IPD_FILE].iter("catalogSeqNumber")
            if csn.get("item")
        }

        hotspots_without_item = [
            (gid, item) for gid, item in svg_hotspots.items() if item not in catalog_items
        ]
        if hotspots_without_item:
            fail(f"(c) SVG hotspots with no matching 941 catalogSeqNumber item: {hotspots_without_item}")
        else:
            ok("(c) every SVG hotspot's data-ipd-item matches a 941 catalogSeqNumber item")

        svg_data_items = {item for item in svg_hotspots.values() if item is not None}
        items_without_hotspot = sorted(catalog_items - svg_data_items)
        if items_without_hotspot:
            fail(f"(c) 941 catalogSeqNumber items with no SVG hotspot: {items_without_hotspot}")
        else:
            ok("(c) every 941 catalogSeqNumber item has at least one SVG hotspot")

        # ---------- (d) the fault-to-part chain against the ground truth ----------
        catalog_partnum = {
            csn.get("item"): (csn.findtext(".//partNumber") or "").strip()
            for csn in trees[IPD_FILE].iter("catalogSeqNumber")
        }

        fault_texts = [
            (e.text or "").strip() for e in trees[FAULT_FILE].iter("faultCodeText")
        ]
        section_match = None
        for text in fault_texts:
            m = re.search(r"section (\d+)", text)
            if m:
                section_match = m.group(1)
                break

        gt_ipd = gt["citations"]["ipd"]
        gt_hotspot_ids = gt_ipd.get("hotspot_ids", {})
        gt_faulted_section = gt_hotspot_ids.get("faulted_section")

        if section_match is None:
            fail(f"(d) no 'section N' found in 421 faultCodeText {fault_texts!r}")
        else:
            sec_from_fault = f"sec-{int(section_match):02d}"
            if sec_from_fault != gt_faulted_section:
                fail(f"(d) 421 fault section {sec_from_fault!r} != GT hotspot_ids.faulted_section {gt_faulted_section!r}")
            else:
                ok(f"(d) 421 fault section matches GT hotspot_ids.faulted_section {gt_faulted_section!r}")

        gt_item = gt_ipd.get("item")
        for key, hid in gt_hotspot_ids.items():
            if hid not in svg_ids:
                fail(f"(d) GT hotspot_ids.{key} {hid!r} not found in the SVG")
            if hid not in ipd_ids:
                fail(f"(d) GT hotspot_ids.{key} {hid!r} not found among 941 hotspots")
            svg_item = svg_hotspots.get(hid)
            if svg_item != gt_item:
                got_pn = catalog_partnum.get(svg_item, "?")
                want_pn = catalog_partnum.get(gt_item, "?")
                fail(
                    f"(d) SVG hotspot {hid!r} (GT {key}) has data-ipd-item {svg_item!r} ({got_pn}) "
                    f"!= GT citations.ipd.item {gt_item!r} ({want_pn})"
                )
            else:
                ok(f"(d) SVG hotspot {hid!r} (GT {key}) data-ipd-item matches GT item {gt_item!r}")

        gt_part_number = gt_ipd.get("part_number")
        item_partnum = catalog_partnum.get(gt_item)
        if item_partnum != gt_part_number:
            fail(f"(d) 941 item {gt_item!r} partNumber {item_partnum!r} != GT part_number {gt_part_number!r}")
        else:
            ok(f"(d) 941 item {gt_item!r} partNumber matches GT part_number {gt_part_number!r}")

        gt_icn = gt_ipd.get("icn")
        icn_mismatch = False
        for g in trees[IPD_FILE].iter("graphic"):
            icn_val = g.get("infoEntityIdent")
            if icn_val != gt_icn:
                fail(f"(d) 941 graphic infoEntityIdent {icn_val!r} != GT icn {gt_icn!r}")
                icn_mismatch = True
        if not icn_mismatch:
            ok(f"(d) every 941 graphic infoEntityIdent matches GT icn {gt_icn!r}")

    # ---------- (e) internalRef irtt01 resolves to a figure/@id in the same module ----------
    for name in DM_FILES:
        fig_ids = {f.get("id") for f in trees[name].iter("figure") if f.get("id")}
        for iref in trees[name].iter("internalRef"):
            if iref.get("internalRefTargetType") != "irtt01":
                continue
            target = iref.get("internalRefId")
            if target not in fig_ids:
                fail(f"(e) {name}: internalRef {target!r} does not resolve to a figure/@id in this module")
            else:
                ok(f"(e) {name}: internalRef {target!r} resolves to a figure in this module")

    return _finish()


def _finish() -> int:
    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed.")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
