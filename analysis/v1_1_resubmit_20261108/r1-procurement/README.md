# R1 procurement substitution, 2026-11-08

R1 remains 7.50 MΩ, 1%, 100 ppm/°C in the same 0402 footprint and unchanged charge-ceiling circuit. Procurement changed from FOJAN FRC0402F7504TS / LCSC C3013187 to UNI-ROYAL 0402WGF7504TCE / C423135 after the parent task's primary-datasheet review and live stock check. Availability is time-sensitive; see the parent sourcing evidence for the observed quantity.

The datasheet field points to the manufacturer-authored Royalohm PDF hosted by TME: https://www.tme.eu/Document/4f50d320a6ddacb273098f84373b6259/rezystor-smd.pdf

Exactly eight R1 properties changed in each of the canonical schematic and PCB: Datasheet, Description, Manufacturer, Manufacturer_Part_Number, LCSC, Supplier Part, MPN, and LCSC Part #. Value, Supplier, footprint, and all other fields remain unchanged. `property-diff.json` has the complete before/after map and hashes. `apply.py` guarded original hashes and verified that reversing only these strings recreated each source byte-for-byte. No geometry, routes, copper fill, net, circuit, or formatting changes were made.

Final canonical hashes:

- PCB: `406a3a0797275d76d41da72e34d95c741453f80384fdd078577d3291b3bdadec`
- schematic: `c63bf8333c120048e29ae4d5024a7a088d5c89d096a356b02b6aa4929408f62a`

Fresh native DRC with in-memory refill and schematic parity: zero violations, zero unconnected items, zero parity issues. Fresh ERC, including exclusions: zero unexcluded findings and the same two documented warnings, for LIS2DH12 SDO/SA0 grounded for I2C address selection and unused TMP117 ALERT grounded. The all-severities ERC command returns code 5 because it reports those existing excluded warnings. No exclusion or rule was added.

`before/` and `after/` preserve the source bytes. Validation used the exact project and design rules, with project library symlinks, and did not save/refill the canonical board. `verification.json` binds checks to the current hashes. The earlier local geometry and physical-copper audit remains applicable because the substitution changed only descriptive strings; the parent task is independently checking the revised netlist and exports.
