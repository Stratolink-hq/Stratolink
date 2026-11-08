#!/usr/bin/env python3
"""Read-only, hash-bound assembly envelope screen for the v1.1 resubmission.

Run the native snapshot extractor first. This intentionally does not infer body
clearance from copper or KiCad courtyards. See dimensions.json for provenance.
"""
import argparse
import csv
import hashlib
import itertools
import json
import math
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rectangle(x, y, dimensions):
    w, h = dimensions
    return [x - w / 2, y - h / 2, x + w / 2, y + h / 2]


def separation(a, b):
    dx = max(a[0] - b[2], b[0] - a[2], 0)
    dy = max(a[1] - b[3], b[1] - a[3], 0)
    return math.hypot(dx, dy)


def audit(native_path, pcb_path, bom_path):
    native = json.loads(native_path.read_text())
    source_hash = sha(pcb_path)
    assert native['sha256'] == source_hash, 'Native snapshot does not match PCB'
    rules = json.loads((HERE / 'dimensions.json').read_text())
    rows = list(csv.DictReader(bom_path.open()))
    refs = [row['Designator'] for row in rows]
    assert len(refs) == len(set(refs)) == 57, 'Expected exactly 57 unique fitted refs'
    assert 'U6' not in refs
    assert {'C15', 'R21', 'C14', 'C23', 'R27'} <= set(refs)
    parts = {}
    for row in rows:
        ref = row['Designator']
        f = native['footprints'][ref]
        angle = f['angle']
        assert abs(angle / 90 - round(angle / 90)) < 1e-9, (ref, angle)
        x, y = f['at']
        if ref in rules['ref_rules']:
            rule_name = rules['ref_rules'][ref]
        elif ref.startswith('R'):
            rule_name = 'r0402_yageo_vishay' if row['Comment'].startswith(('RC0402', 'CRCW0402')) else 'r0402_other'
        elif ref.startswith('C'):
            rule_name = next(k for k in ('c0402', 'c0603', 'c0805') if '_' + k[1:] + '_' in row['Footprint'])
        else:
            raise AssertionError(('Missing dimensions', ref))
        rule = rules['groups'][rule_name]
        if 'expected_mpn' in rule:
            assert row['Comment'] == rule['expected_mpn'], (ref, 'MPN does not match qualified dimensions')
        if 'expected_lcsc' in rule:
            assert row['LCSC Part #'] == rule['expected_lcsc'], (ref, 'LCSC identity mismatch')
        dims, screen = rule['nominal_mm'][:], rule['screen_mm'][:]
        if rule.get('fixed_board_angle') is not None:
            assert angle == rule['fixed_board_angle'], (ref, 'revisit fixed pose', angle)
        elif abs(round(angle / 90)) % 2:
            dims.reverse()
            screen.reverse()
        if ref == 'U2':
            # Enclose both STEP-origin and frozen-CPL nominal registrations.
            x -= 7.7575
            y += 7.5225
        parts[ref] = {
            'mpn': row['Comment'], 'lcsc': row['LCSC Part #'],
            'layer': f['layer'], 'native_anchor_mm': f['at'], 'angle_deg': angle,
            'body_center_mm': [x, y], 'dimension_rule': rule_name,
            'nominal_mm': dims, 'screen_mm': screen,
            'nominal_box_mm': rectangle(x, y, dims),
            'screen_box_mm': rectangle(x, y, screen),
        }
    counts = Counter(p['layer'] for p in parts.values())
    assert dict(counts) == {'F.Cu': 41, 'B.Cu': 16}, counts
    pairs = []
    for a, b in itertools.combinations(refs, 2):
        if parts[a]['layer'] != parts[b]['layer']:
            continue
        pairs.append({
            'refs': [a, b], 'layer': parts[a]['layer'],
            'nominal_clearance_mm': separation(parts[a]['nominal_box_mm'], parts[b]['nominal_box_mm']),
            'screen_clearance_mm': separation(parts[a]['screen_box_mm'], parts[b]['screen_box_mm']),
        })
    pairs.sort(key=lambda pair: pair['screen_clearance_mm'])
    assert len(pairs) == math.comb(41, 2) + math.comb(16, 2) == 940
    failures = [p for p in pairs if p['screen_clearance_mm'] < 0.2 - 1e-9]
    u3 = parts['U3']
    u3_keepout = rectangle(*u3['body_center_mm'], [10.1, 11.1])
    keepout_pairs = sorted([
        {'ref': ref, 'clearance_to_keepout_mm': separation(p['screen_box_mm'], u3_keepout)}
        for ref, p in parts.items() if ref != 'U3' and p['layer'] == 'F.Cu'
    ], key=lambda p: p['clearance_to_keepout_mm'])
    u1 = native['footprints']['U1']
    pad1 = next(p for p in native['pads'] if p['ref'] == 'U1' and p['pin'] == '1' and p['layer'] == 'B.Cu')
    relative = [-(pad1['at'][0] - u1['at'][0]), pad1['at'][1] - u1['at'][1]]
    assert relative[0] < 0 and relative[1] < 0, 'U1 must index upper-left in bottom-facing north-up view'
    return {
        'schema_version': 1, 'result': 'FAIL' if failures else 'PASS',
        'pass_scope': '940 same-face pairs of all 57 fitted SMT parts clear 0.2 mm under the explicitly listed centered package-envelope screen; this is not a factory process guarantee.',
        'source_pcb': str(pcb_path.resolve()), 'source_pcb_sha256': source_hash,
        'source_native_snapshot': str(native_path.resolve()), 'source_native_sha256': sha(native_path),
        'source_bom': str(bom_path.resolve()), 'source_bom_sha256': sha(bom_path),
        'dimension_rules_sha256': sha(HERE / 'dimensions.json'),
        'fitted_refs': refs, 'fitted_count': len(refs), 'layer_counts': dict(counts),
        'fitted_parts': {ref: {'mpn': p['mpn'], 'lcsc': p['lcsc']} for ref, p in parts.items()},
        'threshold_mm': 0.2, 'same_face_pair_count': len(pairs),
        'minimum_clearance_mm': pairs[0]['screen_clearance_mm'],
        'minimum_pair': pairs[0], 'below_0p2_pairs': failures,
        'u3_manufacturer_keepout': {'global_box_mm': u3_keepout, 'closest_pairs': keepout_pairs[:8]},
        'u1_orientation': {'pad1_native_mm': pad1['at'], 'center_native_mm': u1['at'],
                           'bottom_facing_relative_mm': relative, 'required_pin1_corner': 'upper-left'},
        'assumptions_and_limits': rules['assumptions_and_limits'],
        'parts': parts, 'pairs': pairs,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--pcb', type=Path, required=True)
    parser.add_argument('--bom', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.native, args.pcb, args.bom)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ('result', 'source_pcb_sha256', 'fitted_count', 'same_face_pair_count', 'minimum_pair', 'below_0p2_pairs')}, indent=2))
