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

## License

MIT, like the rest of this repository.
