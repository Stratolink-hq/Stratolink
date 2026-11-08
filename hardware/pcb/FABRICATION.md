# v1.1 pilot fabrication and assembly intent

Current status, 8 November 2026: **corrected pilot layout verified; replacement cart saved and reviewed**. PCB **Y28-2680969A** and PCBA **SMT026110862453-2680969A** contain five PCBs and three Standard PCBA assemblies on both sides, U6 omitted. All 57 fitted identities, sides and selection checkboxes were verified. No replacement order has been submitted or paid, and manufacturing has not been approved. Cancellation of Y27-2680969A / SMT026110264457_Y27 is requested but unconfirmed. The [replacement review](../../analysis/v1_1_resubmit_20261108/README.md) and [matching manifest](../gerbers/v1.1-resubmit-20261108/manifest.json) identify the new files. Prior production approval does not apply to this revision.

## Construction

- Two layers, **0.40 mm nominal finished FR4**, approximately **23.364 × 57.305 mm** outline envelope. CAD models 0.035 mm copper per face, 0.31 mm core and 0.01 mm mask per face. Confirm finished construction and tolerance with the fabricator.
- **ENIG, GREEN SOLDER MASK BOTH SIDES, NO SILKSCREEN.** Preserve supplied selective mask openings and ordinary-via tenting. Expose the solar ground banks, positive PTH lands and copper polarity marks. Native reference text stays on fabrication layers. Keep the supplied mask intent. JLC may use its standard assembly stencil process, preserving the U6-only omission and avoiding a second global reduction of already reduced apertures.
- Solar cuts are **open unplated notches**. Programming contacts are ordinary PTH holes. No edge plating or castellation process is selected.
- Use matching copper, drill, outline and mask files with the deliberate **pilot paste variant** below. Do not mix revisions. Enabled DRC includes the reviewed 0.10 mm copper process floor and 0.20 mm ordinary routed-edge minimum, with named contact/fine-pitch exceptions.

U1 uses native +0.04 mm perimeter mask expansion, preserving its copper, paste, exposed-pad mask and thermal holes. U4 and L2 use +0.05 mm. Actual plotted apertures pass the scoped 0.09 mm foreign-copper and 0.10 mm web checks. The [mechanical/mask review](../../analysis/v1_1_engineer_review_20261015/mechanics/README.md) records distances and limits. Supplier CAM must confirm registration, mask dams, tenting and thin-board processing.

## Pilot population and stencil

The native design includes **AS7331-AQFM C20482877** at U6. Initial automated assembly **omits U6 only**. Populate **C14/C23, CL05B104KO5NNNC C1525, 100 nF**, and **R27, MCU0805MD3304BP500 C4313228, 3.3 MΩ ±0.1% ±25 ppm/K**. Do not substitute an ordinary 100 ppm/K resistor.

The pilot front paste removes **exactly 16 U6 pad apertures**. All other front paste and all rear paste remain. Full-design paste is archived separately under `native/full-design-paste/`; the stencil-only derived PCB and plots are under `native/stencil/`. [Stencil proof](../gerbers/v1.1-resubmit-20261108/stencil-population-proof.json). This pilot stencil is unsuitable for a later populated UV build.

U7's twelve apertures are **81% of copper-land area**, or 90% linear dimensions. Do not reduce them again. A **100 µm stencil** was the design reference, within ST's 90–150 µm recommendation. JLC's standard stencil and double-sided assembly process is acceptable subject to its engineering review of the supplied apertures. Future AS7331 population requires separately reviewed stencil/process, actual supplier-model pin-1 orientation, MSL3 handling and sensor reflow/cleaning limits. Keep the optical aperture free of solder, flux, coatings, glue and tape. [UV assembly requirements](../../analysis/v1_1_release_20261012/as7331/review/requirements.md).

## Part identities and placement review

Use exact MPN/LCSC identities from the generated [BOM](../gerbers/v1.1-resubmit-20261108/BOM-stratolink.csv), with its matching [CPL](../gerbers/v1.1-resubmit-20261108/CPL-stratolink.csv). The package has **58 full-design / 57 pilot automatic-assembly references**, **30 pilot groups** and **11 manual/DNP exclusions**. U5 is TMP117AIYBGR C2871893; U2 is RAK3172-8-SM-NI C5452091. R4 is RC0402FR-073M65L C477700; D1/D3 are PESD5V0U1BB C5272735.

Power identities: R1 **UNI-ROYAL 0402WGF7504TCE C423135**, U8 **TLV8801DBVT C544879**, R24/R25 **FRC0402F4754TS C2998153**, R26 **0402WGF220JTCE C25092**, C22 **CL05B104KO5NNNC C1525**. R1's stock-driven substitution changes procurement metadata only; its 7.50 MΩ value, ±1% tolerance and circuit connections remain. See the [substitution review](../../analysis/v1_1_resubmit_20261108/r1-sourcing.md). Preserve U8 feedback before R26 and the C5 midpoint connection. U8 is now on **F.Cu at native 180°**, replacing the earlier rear placement.

**The replacement cart preview has passed the placement review; later factory production files require their own review.** Current CPL values include **U1 270°, U5 180° and front U8 90°**. U8's supplier angle differs from its native 180° orientation: the new preview shows three leads right and pin 1 lower-right. The [replacement review](../../analysis/v1_1_resubmit_20261108/README.md) records all seven fitted IC indices. The [supplier review](SUPPLIER_REVIEW.md) and [October parts sweep](../../analysis/v1_1_final_sweep_20261016/population/README.md) cover the prior population. R1 now uses the identity above. U4's black circle is its pressure port, not its pin-1 marker. U6 has no pilot CPL row; its supplier rotation requires a separate preview before a populated build.

The intended order is **Standard PCBA, both sides, five PCBs / three assembled, green 0.40 mm FR4, 1 oz copper, ENIG, no silkscreen**. The saved rail envelope is 71.36 × 71.30 mm. JLC must still accept rail/tab positions, mask registration, stencil and thin-board handling. J1/J2/J20 and the other manual parts are excluded from automatic assembly.

## Manual assembly after reflow and cleaning

**C5 supercapacitor:** retain **DMF4B5R5G105M3DTA0**, at **(64.875, 66.007) mm on the rear, native 180°**. Fit after reflow and cleaning using the CAP-XX secondary soldering process. Pad 1 is positive, pad 2 negative and pad 3 **SC_MID**, not ground. Maximum case clearance is **2.306 mm to the outline**, **0.696 mm to AE1's rear land** and **0.920 mm to the nearest Tag-Connect hole** before placement, insulation and solder allowance. Inspect these actual gaps and measure both cells.

**J1/J2 solar panels:** each **1.0 × 2.0 mm unplated notch** seats the prepared negative terminal against its straight upper bank. Wet the GND lands on both faces; the model targets approximately 1.3 mm straight-bank overlap. Lower positives use **0.70 mm holes / 1.40 mm lands**. The display model uses 0.50 mm formed wire with insulation on the return. Measure real terminal thickness and exposed foil; model geometry does not establish strength or bend limits.

**J3/J4 programming wires:** **1.00 mm pitch, 0.50 mm holes, 0.88 mm front lands, 1.20 × 0.88 mm rear lands**, rear offset 0.12 mm inward. Solder temporary wires from the enlarged rear side. Preserve pin 1 and avoid bridging the roughly 0.12 mm land gap. These are PTH contacts, not castellated edge connectors. J20 remains an unsoldered Tag-Connect interface.

**AE1/AE2 antennas:** AE2 is at **(59.38, 33.13) mm, native 90°**, with the **48 mm GNSS wire upward**. AE1's **82 mm LoRa wire points downward**. Use straight enameled copper wire, with enamel removed at the joint. [Published starting cuts](https://stratolink.org/docs/hardware#antennas-and-suspension), measured from the feed, are 82 mm at 915 MHz, 86 mm at 868 MHz, 83 mm compromise and 48 mm GNSS L1. Record actual diameter, cut and solder exit; evaluate the completed antenna assembly. No spring or chip antenna is ordered.

The nominal GNSS wire clears the solar model by **20.54 mm**. Its model includes a small display intersection with the board surface; bend/standoff and wire diameter are not manufacturing tolerances. Keep the bridle behind and clear of the wire throughout motion. A projected string crossing alone is not a physical collision. [Native geometry and renders](../../analysis/v1_1_engineer_review_20261015/mechanics/README.md).

**H1/H2 suspension:** **2.00 mm plated holes / 3.20 mm GND rings**. Pass the thin stretchy line through both holes to form the triangular bridle. Check actual corner loading, rim wear and knot security.

## Release record and physical acceptance

Use the [replacement review](../../analysis/v1_1_resubmit_20261108/README.md), [package manifest](../gerbers/v1.1-resubmit-20261108/manifest.json), BOM, CPL and [fabrication ZIP](../gerbers/v1.1-resubmit-20261108/fabrication-review.zip) together. The dated package verification and downloadable bundles record their source hashes. Factory CAM and physical acceptance remain separate.

Keep manual production-file and placement confirmation enabled. U1 pin 1 must be upper-left beside C4/L1 in the bottom-facing north-up supplier view, as corrected in JLC's November 8 image. Recheck all populated ICs against native pads when the factory production files arrive.

The [October populated-UV variant](../gerbers/v1.1-final-uv-20261016/README.md) is a frozen older layout. It is not a populated alternative to this replacement. Any later populated-AS7331 build needs fresh matching exports, sourcing, orientation review and the sensor assembly requirements.

Use **`stratolink_v1_1_uv_dnp`** firmware while U6 is absent. Verify TMP117 ACK/ID/readings, unavailable UV/lux/acoustic reporting, pressure/IMU/GNSS, radio transients, solar joint and bridle security. Measure charge plateau, both cell voltages, midpoint stability, cold leakage/ESR, dark current and sunrise recovery. **Cold panel Voc/I–V and harvester input-voltage/input-power limits remain unresolved physical bounds.** A later AS7331 build also needs a validated driver, controlled optics, raw data and calibration before an ozone claim.

See [TODO.md](TODO.md), [pilot acceptance](../../analysis/v1_1_release_20261012/pilot-acceptance.md), [power review](../../analysis/v1_1_release_20261012/power/README.md) and [AS7331 requirements](../../analysis/v1_1_release_20261012/as7331/review/requirements.md).
