# Assembly body-clearance review

**PASS for the stated envelope screen.** [final-clearance.json](final-clearance.json) covers PCB SHA-256 `406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec`. All 940 same-face pairs clear 0.2 mm. The smallest conservative clearance is 0.255 mm between U3 and U5; their nominal clearance is 1.180 mm.

This review measures package envelopes, independently of copper clearances and KiCad courtyards. The intended factory population is 57 SMT parts: 41 front and 16 back. U6 remains DNP; C15, R21, C14, C23 and R27 are fitted. There are 940 same-face component pairs.

R1 now uses **UNI-ROYAL 0402WGF7504TCE, C423135**. The final audit uses the regenerated 8 November BOM and records MPN/LCSC identities for every fitted part. R1 retains the conservative 1.15 by 0.65 mm envelope, which contains the new manufacturer maximum of 1.10 by 0.55 mm. Its exact identity is asserted; the old FRC BOM is rejected. See the [sourcing review](../r1-sourcing.md).

The acceptance threshold is the 0.2 mm body spacing JLC stated for this order. Dimensions, their evidence and any engineering allowances are recorded per family in [dimensions.json](dimensions.json). A result is bound to the exact PCB SHA-256, native geometry snapshot and population BOM. It is not an assembly-yield guarantee.

| Pair | Nominal envelope gap | Conservative screen gap |
| --- | ---: | ---: |
| C15 to U2 | 0.670 mm | 0.595 mm |
| R21 to U2 | 0.700 mm | 0.625 mm |
| R11 to U3 | 1.260 mm | 0.335 mm |
| U3 to U5, smallest conservative gap | 1.180 mm | 0.255 mm |

The separate manufacturer U3 keepout check clears U5 by 0.655 mm and R11 by 0.735 mm. The final native extraction confirms C15 at X56.03/Y78.400998, R21 at X56.00/Y79.546999 and R11 at X68.95/Y41.84 mm. U2 and the other fitted part placements remain unchanged.

## Baseline findings

[baseline-clearance.json](baseline-clearance.json) is the negative control on original PCB SHA `e02bf87186fc86b90569b6ea25041a34c7d2e32ef39b951847956cc2d2eb0f13`.

- C15 and R21 overlap the conservative U2 body envelope. Their large copper-to-pad spacing did not represent component-body spacing.
- R11 clears the nominal U3 body and the manufacturer's recommended keepout. It does not clear the additional conservative residual-tab envelope described below. This is a tolerance precaution, not an observed factory collision.
- No other pair fails the stated envelope screen.

## MAX-M10S residual tab

The [MAX-M10S datasheet](https://content.u-blox.com/sites/default/files/MAX-M10S_DataSheet_UBX-20035208.pdf), UBX-20035208 R08, page 17, gives maximum dimensions A = 10.7 mm and B = 9.8 mm, with residual tab P up to 0.6 mm. The drawing shows P beyond the substrate edge dimensioned by A and warns that the residual tab's shape and position can vary. The [rendered drawing](max-m10s-dimensions.png) preserves that evidence.

The [integration manual](https://content.u-blox.com/sites/default/files/MAX-M10S_IntegrationManual_UBX-20053088.pdf), UBX-20053088 R05 dated 28 April 2026, page 82, Figure 30, independently recommends an 11.1 by 10.1 mm component keepout. See the [rendered footprint](max-m10s-footprint.png). In the current board pose that is 10.1 mm in board X and 11.1 mm in Y.

We report both checks. The extra conservative screen uses a centered 10.7 by 9.8 mm maximum body and allows a 0.6 mm tab at either length end, enclosing all of those cases in an 11.9 by 9.8 mm box. This intentionally goes beyond the recommended keepout and does not assert that maximum tabs actually occur on both ends. A small upward move of R11 removes the ambiguity without moving the GNSS module.

## U1 orientation

The actual U1 pad-1 position, with X mirrored for the bottom component-facing view, is upper-left relative to its package center. The script asserts this from the new native snapshot. The new factory DFM must retain that physical orientation. The November 8 corrected factory image showed this same upper-left index. The current orientation target and supplier import convention are summarized in the [replacement review](../README.md); a CPL rotation number alone does not establish physical pin 1.

## Scope and limits

- IC sources include actual package maximum dimensions. U2 uses the union of its STEP-origin and CPL nominal registrations plus a stated allowance because the available drawing has no dimensional tolerance.
- For some passives, enlarged family envelopes are engineering screening assumptions, not independently certified dimensions for each incoming lot. Each assumption is identified in the dimension table.
- Calculations use design centers. They do not model placement error, solder spread, reflow movement or thin-board deformation.
- This screen excludes hand-fitted C5, antennas, solar parts, empty U6, and panel or nozzle access. These require the separate manufacturing and assembly review.
- The native extractor is read-only. The audit changes no PCB or schematic data.

## Reproduce

Use KiCad's Python for `analysis/v1_1_peer_review_20261014/power/snapshot_assembly.py`, passing the PCB and output native JSON. Then run:

```sh
python3 analysis/v1_1_resubmit_20261108/assembly-review/audit.py \
  --native analysis/v1_1_resubmit_20261108/assembly-review/final-native.json \
  --pcb hardware/pcb/stratolink.kicad_pcb \
  --bom hardware/gerbers/v1.1-resubmit-20261108/BOM-stratolink.csv \
  --output analysis/v1_1_resubmit_20261108/assembly-review/final-clearance.json
```

The audit rejects a snapshot whose PCB hash does not match the supplied board, asserts every fitted reference is present and records the exact population BOM hash. The release verifier independently compares those fitted references with the regenerated BOM.
