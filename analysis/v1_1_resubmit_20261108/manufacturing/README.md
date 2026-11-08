# Replacement manufacturing package, 8 November 2026

This directory contains the export and verification steps for the C15/R21 clearance correction, R11's additional allowance for the GNSS module shield tab, and the later R1 procurement substitution. The previous `hardware/gerbers/v1.1-final-20261016` package remains frozen. The current output is `hardware/gerbers/v1.1-resubmit-20261108`.

Export and verification passed for PCB SHA-256 `406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec`. [verification.json](verification.json) records the package checks and exact independent body-audit hash. [upload-manifest.json](upload-manifest.json) lists the three replacement upload files and hashes. The old October package and original download ZIPs still match every recorded hash.

The export command used the final candidate hash:

```sh
python3 analysis/v1_1_resubmit_20261108/manufacturing/export.py --pcb-sha256 406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec
python3 analysis/v1_1_resubmit_20261108/manufacturing/verify_r1_physical_equivalence.py
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 analysis/v1_1_resubmit_20261108/manufacturing/verify.py --pcb-sha256 406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec --body-audit analysis/v1_1_resubmit_20261108/assembly-review/final-clearance.json --r1-amendment analysis/v1_1_resubmit_20261108/r1-procurement/property-diff.json --reuse-physical-proof analysis/v1_1_resubmit_20261108/manufacturing/r1-physical-equivalence.json
```

The exporter refuses to overwrite an existing output folder. Preserve this frozen output if reproducing the process elsewhere. It uses the established native KiCad generator with explicit green mask, ENIG and no silkscreen. Only U6 is omitted from assembly and its 16 paste apertures removed from the pilot stencil. C15, R21, R19, C14, C23 and R27 remain fitted. BOM remains 57 references, 41 top and 16 bottom. The original `.kicad_pro` editor state is not rewritten by export.

The verifier requires the independent body-clearance audit to pass for the exact final PCB hash and exact fitted-reference set and MPN/LCSC identities. It checks every new manifest input/output/provenance hash, both package ZIPs, the preserved historical download ZIPs, only the approved R1 BOM substitution, unchanged schematic connectivity, native placement centers, only C15/R21/R11 CPL movements, retained U1/U8 rotation conventions, U6-only stencil differences and unchanged outline/NPTH/silkscreen artwork. The only PTH change allowed is one SDA through-via at X66.9/Y42.8 mm, 0.5 mm copper diameter and 0.3 mm drill. Both native via geometry and the exact added Excellon command are checked; every previous drill command must remain identical. DRC and filled-copper connectivity evidence are separate checks coordinated by the parent review. A generator success is not factory acceptance.

## R1 procurement amendment

The original R1 part, FOJAN FRC0402F7504TS / C3013187, had insufficient live JLC stock. The replacement is UNI-ROYAL 0402WGF7504TCE / C423135. The [sourcing review](../r1-sourcing.md) verifies the required 7.50 MΩ, ±1%, 100 ppm/°C, 50 V, 62.5 mW and temperature ratings. Only eight R1 metadata fields changed in PCB and schematic. The verifier compares every other netlist component subtree exactly and keeps R1's value, footprint and pin mapping unchanged. Its smaller documented body remains inside the previous audit envelope.

The pre-amendment November package remains in Git commit `320fc08f1bac5861eec2d52345bd23cb4296fcc9`; [preservation.json](before-r1-amendment/preservation.json) records the additional local backup. The [physical equivalence proof](r1-physical-equivalence.json) shows all 12 fabrication files differ only in creation timestamps and the CPL is byte-identical. JLC may retain the already-uploaded physical ZIP `3d6e5ee781fe8c57edb24daa790908430d78d4476ae0c5875e60102f4f7cb85c`, provided it receives the amended BOM `c9de8cbc9e537c64ba875f3d0f16821d876550b035b95e464bad5d8df6295894`. The fresh package honestly records its newly generated ZIP hash `d2c855cd7a11de0a316d5cecd3cd597126b11e0a8000c2260028087dea8f9be3`; the upload manifest explicitly links the permitted existing-ZIP reuse to this proof. No physical manufacturing change was introduced by the R1 substitution.

## Supplier orientation

The current import retains U1 at bottom CPL 270 degrees because the native footprint has not rotated. The physical target is **pin 1 upper-left in the bottom-facing, board-top-up view**. November 8's corrected factory preview matches that target. The factory did not provide a numerical machine angle, so this package does not infer a new CSV angle from the image. Require manual placement review on the replacement order, including U1 and the three relocated passives. The dated supplier profile updates the evidence and removes stale pending wording without changing any import angle.

## Downloadable CAD

`hardware/v1.1/` is explicitly marked as a superseded draft and must not be synchronized with the active `hardware/pcb/` project. Updated downloadable bundles belong in `hardware/downloads/v1.1-resubmit-20261108/`, preserving previous ZIPs and their recorded manifests. The download builder's default now selects the replacement manifest and dated output directory. Build and check with:

```sh
python3 hardware/downloads/build.py
python3 hardware/downloads/build.py --check
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 hardware/downloads/verify.py --scratch /Users/twarn/Repositories/ai-working/scratch/stratolink-resubmit-20261108/downloads --standard-models /Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels
```

The source repository remote is `git@github.com:Stratolink-hq/Stratolink.git`. At this review's start, local branch `alpha/hardware-v1.1` did not exist remotely; the older `review/hardware-v1.1` branch did. Bundles therefore identify the exact source hash and manufacturing manifest instead of claiming a newly published branch. Export and verification do not upload, push, cancel, place an order, or approve production.

Both dated download bundles were built and checked against the manifest's 166 source hashes. Fresh extraction through KiCad loaded all 68 footprint instances and resolved all 63 attached models from each bundle. This verification does not approve the replacement order's supplier CAM or component-placement preview.
