const base = '/assets/docs/assembly-v1/';
const photoSizes = {"03": [1800, 1350], "15": [1800, 1350], "19": [1800, 1350], "18": [1800, 1350], "14": [1350, 1800], "02": [1800, 1350], "09": [1350, 1800], "05": [1350, 1800], "13": [1800, 1350], "04": [1800, 1350], "08": [1350, 1800], "11": [1800, 1350], "07": [1800, 1350], "06": [1800, 1350], "10": [1350, 1800], "17": [1800, 1350], "01": [1800, 1350], "20": [1800, 1350], "16": [1800, 1350]};
const photoAsset = n => `${base}${n}.${['19', '20'].includes(n) ? 'svg' : 'webp'}`;
const photo = (n, caption) => `<figure class="docs-figure assembly-photo"><a href="${photoAsset(n)}"><img src="${photoAsset(n)}" alt="${caption}" width="${photoSizes[n][0]}" height="${photoSizes[n][1]}" loading="lazy" decoding="async"></a><figcaption>${caption}</figcaption></figure>`;
const pair = (a, ac, b, bc) => `<div class="docs-figure-pair assembly-pair">${photo(a, ac)}${photo(b, bc)}</div>`;
const drawing = (name, caption) => `<figure class="docs-figure assembly-drawing"><a href="${base}${name}.svg"><img src="${base}${name}.svg" alt="${caption}" loading="lazy"></a></figure>`;
export const assemblyGuide = `
<p>This build starts with a v1 board assembled by JLCPCB. Fit the solar leads, antennas, supercapacitor, and solar panels by hand. The photos follow a 9.5 g payload assembled in October 2026.</p>
<p>Have fine insulated hookup wire, 22 AWG enamelled copper antenna wire, copper support wire, heat-shrink tubing, Kapton tape, solder, a sharp blade, cutters, pliers, tweezers, a multimeter, and a scale ready. Inspect the assembled PCB before starting. Keep it unpowered while soldering.</p>
<h3>1. Add the solar leads</h3>
<p>Cut four short lengths of fine insulated wire: two red positive leads and two black negative leads. About 10 mm is a starting estimate; leave enough reach for the joints shown below without putting tension on them. Strip and tin the ends.</p>
<p>Solder one red lead to <strong>+SOLAR</strong> and one black lead to <strong>GND</strong> on each side of the board. Match the pad labels or schematic. Feed the wires through the holes where possible. If solder already fills the holes, the red lead can attach to the top-side pad and the black lead to its ground pad on the underside.</p>
${photo('01', 'Short solar leads soldered to the board. The antennas were fitted before these photos.')}
<h3>2. Cut and fit the antennas</h3>
<p>Use straight 22 AWG enamelled copper wire. The GPS antenna is the shorter one: start at <strong>48 mm</strong>. For LoRa, start at <strong>82 mm for 915 MHz</strong>, <strong>86 mm for 868 MHz</strong>, or <strong>83 mm</strong> for the 868–928 MHz compromise. Measure from the feed point to the tip.</p>
<p>Make a small bend at the mounting end so it enters the antenna through-hole. Scrape the enamel from the contact tip all the way around, exposing clean copper, then tin it. Solder the short wire to <strong>AE2 / GPS</strong> and the long wire to <strong>AE1 / LoRa</strong>. Keep the radiating lengths straight. Check the finished antenna with the panels installed, as described under <a href="#antennas-and-suspension">antennas and suspension</a>.</p>
${drawing('antenna-lengths', 'Antenna lengths measured from the feed point. The insertion bend is enlarged for clarity.')}
${photo('02', 'Both antennas mounted, with the remaining wire beside the board.')}
<h3>3. Prepare the solar electrodes</h3>
<p>Each panel has a long electrode at either end. Expose a small area at the center of each electrode and tin it. On the panels shown here, brief sweeping passes with the soldering iron clear the coating. Do not leave the iron resting on the panel: the substrate is very thin. Use just enough solder to leave a small, reflective patch bonded to the electrode.</p>
<p>Illuminate the panel and measure DC voltage across the two prepared electrodes. A positive reading means the red meter probe is on the positive electrode. Mark both polarities. Repeat for the second panel.</p>
${photo('03', 'A solar panel before preparing the electrodes.')}
<h3>4. Measure and straighten the support wire</h3>
<p>Lay the board with its GPS antenna pointing up and one panel on each side. Measure copper wire across the entire assembly, from the far edge of the left panel to the far edge of the right. Allow for the center bends and the short folds over both panel edges before cutting; use the physical layout rather than a fixed cut length.</p>
<p>Clamp one end of the wire to the table. Grip the other end with pliers and pull it straight. Center it across the board and mark the two support-hole positions. The historical v1 PCB places those centers approximately <strong>20.4 mm apart</strong>; match your actual board before bending.</p>
${photo('04', 'Lay out both panels to measure the support wire.')}
${pair('05', 'Pulling the clamped wire straight with pliers.', '07', 'Bend positions measured against the board.')}
<h3>5. Bend and insulate the support</h3>
<p>Make two 90° bends at the marks to form a U. Both long arms should be parallel and pass through the board’s two support holes without forcing them.</p>
<p>Scrape the enamel around both tips. Also expose the inside of the U’s base and the two areas on its arms where the black leads will attach. Tin the exposed copper. Slide heat-shrink over the entire bottom of the U, from one bend to the other, to insulate it from the board. It is fine to open the bend slightly to get the sleeve on, then restore its shape.</p>
${drawing('support-wire', 'Form the U against the board holes, prepare the solder joints, and insulate the center.')}
${pair('08', 'The U-shaped support before insulation.', '09', 'Heat-shrink over the center bend.')}
<h3>6. Install the supercapacitor</h3>
<p>Before folding the support flat, turn the board over. Position the supercapacitor with its printed markings facing you, as shown below. Use a small piece of Kapton tape at its left edge to hold it in place, align its three terminals with the footprint, and solder the three pads without bridging them. Confirm polarity against the footprint and schematic.</p>
<p>The physical mounting does not change the v1 power circuit. Check the <a href="#parts-and-board">energy-store qualification</a> for your board revision before charging it.</p>
${photo('06', 'Supercapacitor on the underside, markings facing outward.')}
<h3>7. Fit the support and connect ground</h3>
<p>Insert both ends of the U through the support holes. Bend the arms outward until the support lies flat and runs perpendicular to the long axis of the board. The heat-shrink-covered base stays on the top face of the PCB; the two arms emerge from underneath.</p>
${drawing('insert-and-fold', 'Insert the U through the two support holes, then fold the arms outward.')}
${photo('10', 'Support inserted and folded flat, perpendicular to the board.')}
<p>Using tweezers, place each black lead against its prepared, tinned section of the support wire and solder it. The copper support is now also the negative connection for both panels.</p>
${photo('11', 'Black leads joined to the tinned support wire.')}
<p>Check continuity from each black lead to the corresponding outer end of the copper support. Once both joints are sound, cover them with short heat-shrink sleeves. Position the sleeves before making any joint that would prevent them sliding into place. Check that the support has no unintended contact with other board pads.</p>
${photo('13', 'The support connections insulated after checking continuity.')}
<h3>8. Position the panels</h3>
<p>Keep the board upside down and place the panels beneath the copper support. On both sides, the <strong>positive electrode goes nearest the board</strong> and the <strong>negative electrode goes at the outer edge</strong>. Keep the two panels at the same height and leave matching gaps beside the board.</p>
<p>Use small pieces of Kapton tape to secure the panels to the support wire. The drawing shows the PCB underside, with the tape crossing over the wire. Check the marked polarity again before soldering.</p>
${drawing('panel-polarity', 'Both inner electrodes are positive. Both outer electrodes connect to the grounded support wire.')}
${photo('14', 'Panel backs facing up, with both positive electrodes nearest the board.')}
<h3>9. Solder the panel connections</h3>
<p>Bend each support tip up and over the outer edge of its panel so it rests on the prepared negative electrode. Solder the tip to the electrode with a brief contact, supporting the panel so the joint is not under tension.</p>
${pair('15', 'Kapton tape holds the panel against the support wire.', '16', 'The support tip folds over the panel edge onto the outer electrode.')}
${photo('17', 'Support wire soldered to the outer, negative electrode.')}
<p>Solder each red lead to the inner, positive electrode of its panel. Repeat on the other side. Inspect the joints and check continuity to the correct board pads before covering the exposed connections with small pieces of Kapton tape.</p>
${photo('18', 'Positive leads connect the board to the inner electrodes.')}
<h3>10. Check and weigh the assembly</h3>
<p>Inspect both sides for loose joints, solder bridges, exposed wire touching components, and panel edges under strain. Verify panel polarity and check for an unintended short between +SOLAR and GND before the first powered test.</p>
${photo('19', 'The completed assembly.')}
<p>Weigh the completed payload and record its mass. This one measured <strong>9.5 g</strong>. Use your own measured mass in the <a href="/docs/balloon-prep#float-calculator">float calculator</a>, accounting for the suspension line and anything else the balloon will carry. Continue with <a href="/docs/getting-started">firmware setup and telemetry checks</a> before preparing for launch.</p>
${photo('20', 'This payload weighed 9.5 g.')}
`;
