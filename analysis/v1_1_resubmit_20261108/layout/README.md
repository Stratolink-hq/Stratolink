# v1.1 local assembly-clearance correction, 2026-11-08

Canonical PCB: `hardware/pcb/stratolink.kicad_pcb`

Layout-only intermediate SHA-256: `532dfc743b315fc4957f4f9cbb4b5d580ec4ca996b48c89840083dfbd979faf0`, committed in `31b97c7`. Commit `320fc08` preserves the complete source state before the later R1 procurement amendment. The current canonical PCB SHA is `406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec`; R1 changed descriptive procurement fields only. See the [current replacement review](../README.md). The original layout evidence below retains its intermediate hashes.

Original SHA-256: `e02bf87186fc86b90569b6ea25041a34c7d2e32ef39b951847956cc2d2eb0f13`

For this layout step, only the PCB and `lib/Stratolink_v1p1_U2_RAK3172.kicad_mod` were promoted. The schematic, project, design rules, footprint tables, and other libraries were unchanged at that point. The later R1 amendment updated eight procurement fields in both PCB and schematic without changing the circuit or geometry. Promotion checked all input hashes before copying. The previously modified project file remains byte-identical to the captured source, SHA `f58bea38aac6cc625cfa81c1337565ce660b4cbf57cc3e444dfb5c4099e4dbe4`.

## Changes

- C15 moved from X56.709998 to X56.03 mm, retaining Y78.400998 and rotation.
- R21 moved from X56.698999 to X56.00 mm, retaining Y79.546999 and rotation.
- The conservative U2 body left edge is X57.20 mm. C15 and R21 nominal body gaps are approximately 0.67 mm, rather than the original near-zero gap. R19 remains in place and populated. The solar divider/filter circuit and all pad nets are unchanged.
- Local PA15 routing follows the relocated parts, with horizontal, vertical, and 45-degree segments. The nearby RST trace moved left 0.23 mm, with its upper corner slightly extended to retain clearance to the moved GND pad.
- U2 now has an accurate nominal 15.5 by 15 mm F.Fab body and an F.CrtYd envelope around the conservative body registration and actual pads, with 0.15 mm excess. Its misleading RAK4260 description was corrected to RAK3172. No silkscreen was added. C15/R21 already had valid F.CrtYd outlines; those originals were retained, and their library files are unchanged.
- R11 moved upward 0.35 mm to Y41.84, retaining X68.95 and rotation. This provides margin against a conservative maximum MAX-M10S residual-tab envelope. It is precautionary, not a confirmed manufacturing collision with the original placement.
- Clearing R11's raised +3.3 V pad required a local SDA route change. The front branch now joins the existing back SDA route through one new via at X66.9 Y42.8, 0.5 mm copper diameter / 0.3 mm drill. Added join segments are 0.19 mm front and 0.253 mm back. All existing vias, component pad geometry, and other component placements are unchanged. A prior trial via position isolated R2.2 ground and was rejected; the final saved copper has no disconnected ground pad or island.

## Verification

- `drc.json`: fresh KiCad 10 refill and schematic parity, **0 violations, 0 unconnected items, 0 parity issues**, using the exact source project and rules. No new DRC exclusions or relaxed constraints.
- `physical_copper.json`: independent graph of native saved polygons on both copper layers, joined only at plated pad/via identities. **59 nets, no foreign-net overlaps, no disconnected pad nets, no orphan copper components.** This includes R2.2 ground.
- `scope-audit.json`: only C15/R21/R11 positions changed; all 68 footprints retained; all 259 pad identities, nets, sizes, drills, shapes, and angles preserved; 13 old local tracks removed, 10 new tracks and one via added, 6 local tracks reshaped; existing vias, zone settings, and board outline unchanged.
- `promotion.json`: guarded source and final hashes.
- `u2-before-after.png` and `r11-before-after.png`: plots from native saved copper. Body envelopes are assembly-review overlays, not new copper geometry.

The physical graph is a geometric connectivity check, not an RF simulation or manufacturer assembly approval. Final all-component body clearance and manufacturer export audits are performed separately by the parent task and independent reviewer.

## Reproduction and evidence

The local `before/` directory contains exact captured PCB, schematic, project, rule/table inputs and the three inspected footprint libraries. These inputs can be restored without overwriting files using [REPRODUCING.md](../REPRODUCING.md); duplicate CAD snapshots are not required in Git. `candidate/` contains the isolated candidate with the full project library and a symlink to the original 3D library. `input-hashes.json` records captured inputs. `prepare.py` initializes a fresh snapshot/candidate directory and will refuse to overwrite one that already exists. `build.py` rebuilds a candidate from the captured PCB, clears stale polygon fills before native editing, preserves project/rules, and writes `changes.json`. Native-generated UUIDs may differ on a rebuild; the promoted hash is authoritative.

Build with KiCad's bundled Python. Run native CLI DRC with `--format json --all-track-errors --schematic-parity --severity-all --exit-code-violations --refill-zones --save-board` on the isolated candidate. Extract geometry using `analysis/v1_1_peer_review_20261014/digital/extract_rf_reference.py`; run `analysis/v1_1_engineer_review_20261015/connectivity/physical_copper.py` with the analysis Python environment. `audit_scope.py` checks the permitted source delta. `plot_regions.py` renders the saved geometry before and after.
