# S1000D array-module fixture

Six synthetic S1000D data modules (model ident code `ODMRAD`) for a fictional radar's
array module, plus a ground-truth file and an acceptance script. Every name, part number
and figure here is synthetic; nothing refers to a real program, manufacturer or customer.

## The six data modules

All six share one SNS: `systemCode=34`, `subSystemCode=1`, `subSubSystemCode=0`,
`assyCode=01`, `disassyCode=00` variant `A`, `itemLocationCode=A`, `issueNumber=001`,
language `EN-US`.

| infoCode | Content |
|---|---|
| 040 (description) | The array, its 32 module positions, built-in test (BIT), and the effect of a failed module. |
| 320 (planning) | On-condition replacement on a BIT failure, plus a periodic inspection; references remove and install. |
| 421 (fault isolation) | Yes/no isolation steps for BIT fault `MRAD-ARR-0417`, ending in a reference to remove and install. |
| 520 (remove) | Preliminary requirements, main procedure, close requirements for removing the module. |
| 720 (install) | Same, for installing a replacement; references the illustrated parts data. |
| 941 (illustrated parts) | One figure: the module, its connector gasket and its screws, with synthetic part numbers and quantities. |
| `ICN-ODMRAD-00001.svg` (illustration) | The array face and Detail A, hand-written and hotspotted; cited by the 941 figure and linked into the 520 and 720 procedures. |

## `ICN-ODMRAD-00001.svg`

The one illustration the 941 figure cites by ICN. The main view is the array face: 32
numbered sections in a 4x8 grid, each an SVG hotspot (`class="hotspot"`) keyed to IPD item
0001, since every section holds an array module. An inset, "Detail A, section 3", is
connected to section 3 by a leader line and breaks that section out into its own three
hotspots: the module (catalog sequence 0001), the connector gasket (0002) and its two screws as
one group (0003), each with a callout number matching its IPD item. Section 3 is the
faulted section the 421 fault isolation and GROUND-TRUTH.json both point at. The SVG is
inert (no script, no event attributes, no external references) and ships its own
`<style>` block so a consumer can restyle `.hotspot` or set `.hotspot.active` to highlight
the one the consumer's pane should call out. The 520 (remove) and 720 (install) procedures
each carry a `<figure>` citing the same ICN, referenced from their relevant step by
`internalRef`.

## GROUND-TRUTH.json

Fixes, confirmed by both the manual's author and its consumer: the fault code and text,
every DMC each option cites, the illustrated-parts number and quantity, the planning
interval, and four remediation options (no fault confirmed on re-run, reseat and re-run,
replace from stock on hand, replace from the nearest site with stock). Each option carries
a `picture_condition` — a boolean expression over the consumer's released-event fields
that decides when that option applies — and a `dry_run`: one example asset, fault and
spares picture, with the option a correct reader must select for it.

Three open questions remain: whether the consumer's per-option shape needs a list of DMCs
or a single one, whether the planning DMC belongs on the replace-from-stock options, and
what a reader does once the on-hand field it currently keys off is retired.

## Running the checks

```
python check.py
```

Needs only `lxml`. Checks that each data module is well-formed, that every
cross-reference resolves to one of the six, and that GROUND-TRUTH.json matches the
manual: the fault code and text, every cited DMC, the illustrated-parts part and
quantity, the planning interval, the four options' `picture_condition`, and the dry
run's expected option. Exits 0 on pass; on failure, exits non-zero and names the check
that failed. Set `GROUND_TRUTH_PATH` to point the script at a different ground-truth
file.

It also checks the illustration: (a) every `graphic/@infoEntityIdent` cited in any
module has a well-formed `<ICN>.svg` alongside it; (b) that SVG is inert (no `script`,
no `foreignObject`, no `on*` attribute, every `href` local-only); (c) the SVG's
`class="hotspot"` ids and the 941's `hotspot/@applicationStructureIdent` ids match one
for one, and every hotspot's `data-ipd-item` joins to a 941 `catalogSeqNumber/@item` and
back; (d) the 421 fault's section number, GROUND-TRUTH.json's `hotspot_ids` and `item`,
and the 941's part number and ICN all agree; (e) every `internalRef` of
`internalRefTargetType="irtt01"` resolves to a `figure/@id` in its own module.

## License

MIT, like the rest of this repository.
