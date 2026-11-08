#!/usr/bin/env python3
"""Independent read-only checks of the promoted November 8 replacement PCB."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = HERE / 'connectivity'
CAD = ROOT / 'hardware/pcb'
BEFORE = HERE / 'layout/before'
OLD = ROOT / 'hardware/gerbers/v1.1-final-20261016'
KPY = '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'
CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
APY = ROOT / 'analysis/.venv/bin/python'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(args):
    result = subprocess.run(list(map(str, args)), cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)


def main():
    OUT.mkdir(exist_ok=True)
    hashes = {name: sha(CAD / name) for name in ['stratolink.kicad_pcb', 'stratolink.kicad_sch']}
    run([CLI, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', OUT / 'netlist.xml', CAD / 'stratolink.kicad_sch'])
    run([KPY, ROOT / 'analysis/v1_1_engineer_review_20261015/connectivity/compare.py',
         '--repo', ROOT, '--before', BEFORE, '--after', CAD,
         '--before-xml', OLD / 'native/netlist.xml', '--after-xml', OUT / 'netlist.xml',
         '--output', OUT / 'comparison.json'])
    run([KPY, ROOT / 'analysis/v1_1_peer_review_20261014/digital/extract_rf_reference.py',
         '--pcb', CAD / 'stratolink.kicad_pcb', '--output', OUT / 'copper.json'])
    run([APY, ROOT / 'analysis/v1_1_engineer_review_20261015/connectivity/physical_copper.py',
         '--geometry', OUT / 'copper.json', '--output', OUT / 'physical-copper.json'])
    d = json.loads((OUT / 'comparison.json').read_text())
    p = json.loads((OUT / 'physical-copper.json').read_text())
    assert not d['schematic']['logical_node_changes']
    allowed_properties = {'Datasheet', 'Description', 'Manufacturer',
                          'Manufacturer_Part_Number', 'MPN', 'LCSC',
                          'Supplier Part', 'LCSC Part #'}
    assert {x['key'] for x in d['schematic']['component_changes']} == {'R1'}
    assert len(d['schematic']['symbol_changes']) == 1
    change = d['schematic']['symbol_changes'][0]
    assert change['ref'] == 'R1'
    assert len(change['changes']) == 1 and change['changes'][0]['key'] == 'property'
    before_props, after_props = ({v[1]: v for v in change['changes'][0][key]}
                                 for key in ['before', 'after'])
    assert before_props.keys() == after_props.keys()
    changed_properties = {k for k in before_props if before_props[k] != after_props[k]}
    assert changed_properties == allowed_properties
    for name in changed_properties:
        before, after = before_props[name], after_props[name]
        assert before[:2] == after[:2] and before[3:] == after[3:]
    assert after_props['Value'][2] == before_props['Value'][2] == '7.50MΩ'
    for name in ['LCSC', 'Supplier Part', 'LCSC Part #']:
        assert after_props[name][2] == 'C423135'
    for name in ['Manufacturer_Part_Number', 'MPN']:
        assert after_props[name][2] == '0402WGF7504TCE'
    assert after_props['Manufacturer'][2] == 'UNI-ROYAL'
    assert {x['key'] for x in d['pcb']['footprint_metadata_changes']} == {'R1'}
    pcb_change = d['pcb']['footprint_metadata_changes'][0]
    pb, pa = pcb_change['before'], pcb_change['after']
    assert {k: v for k, v in pb.items() if k != 'fields'} == {k: v for k, v in pa.items() if k != 'fields'}
    assert {k for k in pb['fields'] if pb['fields'][k] != pa['fields'][k]} == allowed_properties
    for name in allowed_properties:
        assert pa['fields'][name] == after_props[name][2]
    for key in ['physical_pad_changes', 'pad_fabrication_metadata_changes', 'pad_to_net_changes', 'connected_pad_set_changes']:
        assert not d['pcb'][key], key
    assert {x['key'] for x in d['pcb']['footprint_pose_changes']} == {'C15', 'R21', 'R11'}
    for x in d['pcb']['footprint_pose_changes']:
        assert x['before']['angle_deg'] == x['after']['angle_deg']
        assert x['before']['layer'] == x['after']['layer']
    for item in d['pcb']['physical_connectivity']:
        assert item['native_unconnected_count'] == 0
        assert not item['pad_connectivity_mismatches']
    for item in d['pcb']['schematic_parity']:
        assert not item['unexplained_pad_mapping_mismatches']
        assert not item['schematic_pins_missing_board_pad']
    assert not p['foreign_net_overlaps']
    assert not p['disconnected_pad_net_names']
    assert p['net_count'] == 59
    assert d['source_bytes_unchanged']
    assert all(sha(CAD / name) == digest for name, digest in hashes.items())
    summary = {'status': 'PASS', 'source_hashes': hashes, 'net_count': p['net_count'],
               'moved_refs': ['C15', 'R21', 'R11'], 'circuit_changed': False,
               'procurement_change': {'ref': 'R1', 'mpn': '0402WGF7504TCE', 'lcsc': 'C423135',
                                      'value_preserved': '7.50MΩ'},
               'foreign_net_overlaps': [], 'disconnected_pad_nets': [],
               'limitations': 'Electrical and saved-copper checks only. Assembly body clearance is checked separately.'}
    (OUT / 'result.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
