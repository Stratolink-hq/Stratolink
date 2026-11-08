# v1.1 replacement pilots, November 8, 2026

Status: corrected layout, matching exports and replacement cart are verified. PCB cart **Y28-2680969A** and PCBA **SMT026110862453-2680969A** are saved for Teddy's review. Cancellation of the previous order is requested but unconfirmed. No replacement order has been submitted or paid, and manufacturing has not been approved.

Teddy chose to correct the PCB and resubmit the pilot order after JLC refused to populate C15/R21 at less than 0.2 mm component clearance to U2. The prior hand-rework proposal is superseded. The circuit remains unchanged and both passives remain populated. The intended order is five bare PCBs with three Standard PCBA assemblies, both sides, with U6 omitted only.

## Verified local revision

Canonical PCB SHA-256: `406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec`.

Canonical schematic SHA-256: `c63bf8333c120048e29ae4d5024a7a088d5c89d096a356b02b6aa4929408f62a`.

- Move C15 left 0.680 mm and R21 left 0.699 mm, preserving rotation and circuit connections. Add the missing U2 body and courtyard to the board and project library; existing C15/R21 courtyards remain.
- Move R11 upward 0.350 mm to allow for the GNSS module's variable residual tab. Adjust its local SDA/power connections and add one 0.30 mm drilled, 0.50 mm diameter SDA via at (66.9, 42.8) mm.
- Preserve every other component pose, all pad geometry and net assignments, existing vias, outline and zone settings. Only local signal traces and refilled copper change.
- Replace R1 procurement identity with **UNI-ROYAL 0402WGF7504TCE / C423135** after the previous part's JLC stock fell short of the assembly requirement. The 7.50 MΩ value and ±1% tolerance remain; PCB and schematic changes for this substitution are metadata only. The manufacturer maximum body fits within the retained 1.15 × 0.65 mm clearance envelope. See the [sourcing review](r1-sourcing.md) and [metadata-only verification](r1-procurement/verification.json).
- Fresh KiCad DRC: zero violations, zero unconnected items, zero schematic parity findings. Independent saved-copper analysis: 59 nets, no foreign-net overlaps or disconnected pad nets.
- All 57 fitted SMT references, 940 same-face pairs, pass the stated 0.2 mm package-envelope screen. Minimum screened gap is 0.255 mm under the conservative GNSS tab envelope. The audit distinguishes manufacturer dimensions from engineering allowances and excludes placement error and nozzle/process limits.

## Scope and evidence

- `layout/`: captured source, bounded placement/routing correction, native DRC and promotion evidence.
- [Assembly review](assembly-review/README.md): independent same-side body clearance screen of all 57 fitted references, including package dimensional limits. Its [final result](assembly-review/final-clearance.json) records the exact current PCB hash and all MPN/LCSC identities from the regenerated November 8 BOM, including R1.
- `r1-procurement/`: exact PCB/schematic metadata diff, unchanged geometry and fresh native DRC/ERC results for the R1 substitution.
- `verify_connectivity.py`, `connectivity/`: schematic/PCB net parity, unchanged pad geometry, and independent saved-copper connectivity checks.
- `manufacturing/`: dated package generation and verification against source and independent review hashes.
- [Replacement manufacturing package](../../hardware/gerbers/v1.1-resubmit-20261108/README.md).
- [Downloads](../../hardware/downloads/README.md).

The October manufacturing ZIPs are frozen history and must not be mixed with the replacement BOM/CPL. The native design still includes the full U6 circuit, but the replacement pilot BOM/CPL omits U6 and its stencil removes only its 16 paste apertures.

## Saved replacement cart

The saved cart contains **five PCBs and three Standard PCBA assemblies, both sides**. All 57 fitted MPN/LCSC identities, sides and selection checkboxes were compared with the amended BOM. U6 alone remains omitted from automatic assembly; C15/R21 and C14/C23/R27 remain fitted.

Merchandise is **$326.63**, with **$26.60 estimated shipping** and an **estimated subtotal of $353.23**. The site estimates shipment on **November 14, 2026**. This is an estimate, not a guaranteed dispatch date or delivery date.

The cart retains fabrication ZIP SHA-256 `3d6e5ee781fe8c57edb24daa790908430d78d4476ae0c5875e60102f4f7cb85c`. The [physical-equivalence proof](manufacturing/r1-physical-equivalence.json) confirms that its manufacturing geometry matches the regenerated package after the R1 metadata substitution. The amended BOM SHA-256 `c9de8cbc9e537c64ba875f3d0f16821d876550b035b95e464bad5d8df6295894` is uploaded; the CPL is byte-identical across that substitution. See the [package verification](manufacturing/verification.json).

## Cancellation request

Cancellation of PCBA SMT026110264457_Y27 and PCB Y27-2680969A was requested on November 8. JLC has not yet confirmed cancellation, refund/credit terms or transfer of purchased components. No refund amount is assumed. The saved replacement remains separate and unpaid.

## Orientation and later review

The new cart preview was checked in a north-up, component-facing view of each side. Pin-1 indices match: **U1 upper-left, U2 lower-left, U3 lower-right, U4 upper-left, U5 lower-right, U7 lower-left and U8 lower-right**. U1 retains the corrected upper-left index beside C4/L1 in the bottom-facing view; its supplier CPL import convention remains 270 degrees.

This verifies the cart preview, not future factory CAM or final placement files. Those require a separate review before manufacturing approval. The earlier order's approval does not apply to this replacement.

CAD checks do not establish flight qualification. The existing [pilot acceptance procedure](../v1_1_release_20261012/pilot-acceptance.md) still applies to assembled boards.
