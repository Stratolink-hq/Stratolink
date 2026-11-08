# R1 stock substitute

**Recommended: UNI-ROYAL 0402WGF7504TCE, LCSC/JLC C423135.** The root agent's live JLC assembly search reported 10,002 available and selection enabled on 8 November 2026. This is the preferred substitute for FRC0402F7504TS/C3013187, which had only 17 available against a minimum requirement of 20.

| Requirement | Selected substitute |
| --- | --- |
| Resistance | 7.50 MΩ |
| Tolerance | ±1% |
| Temperature coefficient | ±100 ppm/K |
| Power at 70 °C | 62.5 mW (1/16 W) |
| Working voltage | 50 V |
| Operating temperature | -55 to +155 °C |
| Body | 1.00 ±0.10 by 0.50 ±0.05 mm |
| Height | 0.35 ±0.05 mm |

The manufacturer-authored **Royalohm Thick Film Chip Resistors** datasheet, linked by TME's exact-MPN listing, provides voltage, temperature, body and power on page 1 and TCR/order-code decoding on page 3. The 0402 row specifies ±100 ppm/°C above 10 Ω. Its code table gives WG = 1/16 W, F = ±1%, and 7504 = 750 × 10^4 Ω. [Manufacturer datasheet hosted by TME](https://www.tme.eu/Document/4f50d320a6ddacb273098f84373b6259/rezystor-smd.pdf), [exact-MPN documentation page](https://www.tme.eu/en/details/0402wgf7504tce/smd-resistors/royalohm/).

A separate manufacturer letter dated 14 September 2022 explicitly confirms that 0402 WG remains 1/16 W. [Manufacturer power-code clarification](https://www.tme.eu/Document/c283990e907c122bb808207d1578ac7f/POWER_RATING-DTE.pdf).

R1 connects VRDIV to VBAT_OV. Keeping the same resistance and tolerance preserves the nominal divider setting. Its maximum 1.10 by 0.55 mm body fits within the prior audit's 1.15 by 0.65 mm R1 envelope. No footprint, placement or routing change is needed. If part fields change, regenerate the BOM and hash-bound release audit so the new order and repository agree.

## Other candidates checked

- **Vishay CRCW04027M50FKED, C1854640:** electrically and mechanically suitable, but root's actual JLC check found only 18 available against 20 required. A public LCSC indexed listing advertised 260, illustrating why that count cannot substitute for the actual assembly inventory. Vishay standard-mode specifications are 63 mW, 50 V, -55 to +155 °C, ±1%, ±100 ppm/K, maximum 1.05 by 0.55 mm body. [Vishay document 20035, revision 14 April 2026](https://www.vishay.com/docs/20035/dcrcwe3.pdf), [LCSC C1854640](https://www.lcsc.com/product-detail/C1854640.html).
- **UNI-ROYAL HP02WAF7504TCE, C2773987:** technically suitable at 100 mW, 50 V, -55 to +155 °C, ±1%, ±100 ppm/K. Maximum body 1.10 by 0.55 mm. Actual JLC availability was not established by this research. [Manufacturer HP-series datasheet](https://www.tme.eu/Document/01e8c81daaf5ec2d714003d3aef2e855/hp-series.pdf), [LCSC C2773987](https://www.lcsc.com/product-detail/C2773987.html).
- VO C2906433 and Kamaya C7343908 were not recommended because their listings specify 200 ppm/K.

This is read-only sourcing and compatibility research. It did not modify CAD, the BOM, the cart or the order. The research agent had no browser surface, so manufacturer documentation was retrieved through public web tools. Actual JLC stock observations above are explicitly attributed to the root agent's live session. Do not rely on inventory transferring from the cancelled order.
