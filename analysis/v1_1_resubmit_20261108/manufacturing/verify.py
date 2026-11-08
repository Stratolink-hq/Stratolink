#!/usr/bin/env python3
"""Verify the dated replacement package and preserve the previous frozen exports.

Run with KiCad's bundled Python after export.py. No CAD or package writes.
"""
import argparse
import collections
import copy
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
import pcbnew
import wx

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OLD = ROOT / 'hardware/gerbers/v1.1-final-20261016'
NEW = ROOT / 'hardware/gerbers/v1.1-resubmit-20261108'
SOURCE = ROOT / 'hardware/pcb'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def rows(path):
    with path.open() as handle:
        data = list(csv.DictReader(handle))
    result = {r['Designator']: r for r in data}
    assert len(result) == len(data), path
    return result


def artwork(path):
    ignored = (
        r'%TF\.CreationDate,[^*]+\*%',
        r'G04 Created by KiCad \(PCBNEW 10\.0\.0\) date [^*]+\*',
        r'; DRILL file KiCad 10\.0\.0 date .+',
        r'; #@! TF\.CreationDate,.+',
    )
    return '\n'.join(line for line in path.read_text().splitlines()
                     if not any(re.fullmatch(pattern, line) for pattern in ignored))


def netmap(path):
    root = ET.parse(path).getroot()
    return {n.get('name'): sorted((p.get('ref'), p.get('pin'), p.get('pinfunction'), p.get('pintype'))
                                for p in n.findall('node')) for n in root.findall('./nets/net')}


def semantic(element):
    return (element.tag, tuple(sorted(element.attrib.items())), (element.text or '').strip(),
            tuple(semantic(child) for child in element))


def verify_r1_metadata(profile, old_bom, new_bom, previous, current):
    allowed = {'Manufacturer', 'Manufacturer_Part_Number', 'Supplier Part', 'LCSC',
               'MPN', 'LCSC Part #', 'Datasheet', 'Description'}
    schematic = profile['files']['stratolink.kicad_sch']
    pcb = profile['files']['stratolink.kicad_pcb']
    fields = schematic['properties']
    assert set(fields) == allowed and fields == pcb['properties']
    assert schematic['before_sha256'] == previous['source_files']['stratolink.kicad_sch']
    assert schematic['after_sha256'] == current['source_files']['stratolink.kicad_sch']
    assert pcb['after_sha256'] == current['source_files']['stratolink.kicad_pcb']
    assert set(old_bom) == set(new_bom) and len(new_bom) == 57
    changes = {ref for ref in new_bom if old_bom[ref] != new_bom[ref]}
    assert changes == {'R1'}, changes
    expected = dict(old_bom['R1'])
    assert expected['Comment'] == 'FRC0402F7504TS' and expected['LCSC Part #'] == 'C3013187'
    expected.update({'Comment':'0402WGF7504TCE','LCSC Part #':'C423135'})
    assert new_bom['R1'] == expected
    for name in ('Manufacturer_Part_Number','MPN'):
        assert fields[name] == {'before':'FRC0402F7504TS','after':'0402WGF7504TCE'}
    for name in ('LCSC','Supplier Part','LCSC Part #'):
        assert fields[name] == {'before':'C3013187','after':'C423135'}
    assert fields['Manufacturer'] == {'before':'FOJAN','after':'UNI-ROYAL'}
    assert fields['Description'] == {
        'before':'FRC0402F7504TS; 7.50 MΩ, 1%, 100 ppm/°C charge-ceiling resistor',
        'after':'0402WGF7504TCE; 7.50 MΩ, 1%, 100 ppm/°C charge-ceiling resistor'}
    assert fields['Datasheet'] == {
        'before':'https://www.lcsc.com/product-detail/C3013187.html',
        'after':'https://www.tme.eu/Document/4f50d320a6ddacb273098f84373b6259/rezystor-smd.pdf'}
    old_components = {c.get('ref'):c for c in ET.parse(OLD/'native/netlist.xml').findall('./components/comp')}
    new_components = {c.get('ref'):c for c in ET.parse(NEW/'native/netlist.xml').findall('./components/comp')}
    assert set(old_components) == set(new_components)
    for ref, original in old_components.items():
        updated = copy.deepcopy(new_components[ref])
        if ref == 'R1':
            for name, change in fields.items():
                old_fields = original.findall(f'./fields/field[@name="{name}"]')
                new_fields = updated.findall(f'./fields/field[@name="{name}"]')
                assert len(old_fields) == len(new_fields) == 1, name
                assert old_fields[0].text == change['before'] and new_fields[0].text == change['after'], name
                new_fields[0].text = change['before']
                old_props = original.findall(f'./property[@name="{name}"]')
                new_props = updated.findall(f'./property[@name="{name}"]')
                assert len(old_props) == len(new_props) == (0 if name in {'Datasheet','Description'} else 1), name
                for old_prop, new_prop in zip(old_props, new_props):
                    assert old_prop.get('value') == change['before'] and new_prop.get('value') == change['after'], name
                    new_prop.set('value',change['before'])
                if name in {'Datasheet','Description'}:
                    old_value, new_value = original.find(name.lower()), updated.find(name.lower())
                    assert old_value.text == change['before'] and new_value.text == change['after'], name
                    new_value.text = change['before']
        assert semantic(original) == semantic(updated), f'Unexpected component metadata/value/footprint/pin change: {ref}'
    return {'reference':'R1','before':old_bom['R1'],'after':new_bom['R1'],
            'only_eight_approved_r1_fields_changed':True,'all_other_component_subtrees_identical':True,
            'value_footprint_pinmap_unchanged':True}


def verify_added_via(board):
    """Allow only the one root-approved SDA via and its one Excellon hole."""
    before = pcbnew.LoadBoard(str(OLD / 'native/stencil/stratolink.kicad_pcb'))
    def key(via):
        p = via.GetPosition()
        return (p.x, p.y, via.GetWidth(pcbnew.F_Cu), via.GetWidth(pcbnew.B_Cu),
                via.GetDrillValue(), int(via.GetViaType()), via.TopLayer(),
                via.BottomLayer(), via.GetNetname())
    old_vias = [v for v in before.GetTracks() if isinstance(v, pcbnew.PCB_VIA)]
    new_vias = [v for v in board.GetTracks() if isinstance(v, pcbnew.PCB_VIA)]
    # Reuse the frozen board's ordinary through-via type, whose enum spelling
    # differs between KiCad Python bindings. Layer pair remains explicit.
    ordinary_types = {int(v.GetViaType()) for v in old_vias
                      if v.TopLayer() == pcbnew.F_Cu and v.BottomLayer() == pcbnew.B_Cu}
    assert len(ordinary_types) == 1
    expected = (66900000, 42800000, 500000, 500000, 300000,
                ordinary_types.pop(), pcbnew.F_Cu, pcbnew.B_Cu, 'SDA')
    old, new = collections.Counter(map(key, old_vias)), collections.Counter(map(key, new_vias))
    assert not old - new, 'Existing via removed or changed'
    assert new - old == collections.Counter({expected:1}), 'Unexpected native via delta'
    old_art = artwork(OLD / 'gerbers/stratolink-PTH.drl')
    new_art = artwork(NEW / 'gerbers/stratolink-PTH.drl')
    line = 'X66.9Y-42.8'
    assert line not in old_art.splitlines() and new_art.splitlines().count(line) == 1
    assert '; #@! TA.AperFunction,Plated,PTH,ViaDrill\nT1C0.300' in new_art
    active_tool = None
    for command in new_art.splitlines():
        if re.fullmatch(r'T\d+', command):
            active_tool = command
        if command == line:
            assert active_tool == 'T1', 'Added hole must use the 0.300 mm via drill'
    assert '\n'.join(x for x in new_art.splitlines() if x != line) == old_art
    return {'net':'SDA','x_mm':66.9,'y_mm':42.8,'diameter_mm':0.5,'drill_mm':0.3,
            'layers':['F.Cu','B.Cu'],'added_native_vias':1,'added_pth_hits':1,
            'all_previous_via_geometry_and_drill_commands_unchanged':True,
            'previous_pth_sha256':sha(OLD / 'gerbers/stratolink-PTH.drl'),
            'current_pth_sha256':sha(NEW / 'gerbers/stratolink-PTH.drl')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pcb-sha256', required=True)
    parser.add_argument('--moved', nargs='+', default=['C15', 'R21', 'R11'])
    parser.add_argument('--body-audit', type=Path, required=True,
                        help='Independent fitted-body clearance audit for this exact source PCB.')
    parser.add_argument('--r1-amendment', type=Path,
                        help='Exact approved eight-field R1 procurement amendment and schematic hashes.')
    parser.add_argument('--reuse-physical-proof', type=Path,
                        help='Verified timestamp-only equivalence proof for an already uploaded physical ZIP.')
    args = parser.parse_args()
    current = read(NEW / 'manifest.json')
    previous = read(OLD / 'manifest.json')
    assert sha(SOURCE / 'stratolink.kicad_pcb') == args.pcb_sha256
    assert current['source_files']['stratolink.kicad_pcb'] == args.pcb_sha256
    assert current['finish'] == 'green-mask-no-silk'
    assert current['assembly_count'] == 57 and current['design_assembly_count'] == 58
    for name, digest in current['source_files'].items():
        assert sha(SOURCE / name) == digest, name
    packages = {}
    for folder, manifest in ((OLD, previous), (NEW, current)):
        actual = {str(p.relative_to(folder)) for p in folder.rglob('*') if p.is_file() and p.name != 'manifest.json'}
        assert actual == set(manifest['output_files']), (folder, actual ^ set(manifest['output_files']))
        for name, digest in manifest['output_files'].items():
            assert sha(folder / name) == digest, (folder, name)
        for name, digest in manifest['evidence_files'].items():
            assert sha(Path(name)) == digest, name
        with zipfile.ZipFile(folder / 'fabrication-review.zip') as archive:
            names = {p.name for p in (folder / 'gerbers').iterdir() if p.is_file()}
            assert set(archive.namelist()) == names and len(archive.namelist()) == len(names)
            assert all(archive.read(name) == (folder / 'gerbers' / name).read_bytes() for name in names)
        packages[folder.name] = {'output_files_verified': len(actual), 'zip_sha256': sha(folder / 'fabrication-review.zip')}
    legacy_downloads = ROOT / 'hardware/downloads'
    legacy_download_manifest = read(legacy_downloads / 'manifest.json')
    assert legacy_download_manifest['pcb_sha256'] == previous['source_files']['stratolink.kicad_pcb']
    for name, expected in legacy_download_manifest['archives'].items():
        assert sha(legacy_downloads / name) == expected['sha256'], name
        with zipfile.ZipFile(legacy_downloads / name) as archive:
            assert len(archive.namelist()) == len(expected['members'])
            assert set(archive.namelist()) == set(expected['members'])
            assert all(hashlib.sha256(archive.read(member)).hexdigest() == digest
                       for member, digest in expected['members'].items()), name
    assert netmap(NEW / 'native/netlist.xml') == netmap(OLD / 'native/netlist.xml')
    old_bom, new_bom = rows(OLD / 'BOM-stratolink.csv'), rows(NEW / 'BOM-stratolink.csv')
    old_cpl, new_cpl = rows(OLD / 'CPL-stratolink.csv'), rows(NEW / 'CPL-stratolink.csv')
    r1_amendment = None
    if args.r1_amendment:
        r1_amendment = verify_r1_metadata(read(args.r1_amendment),old_bom,new_bom,previous,current)
        r1_amendment.update({'profile':str(args.r1_amendment.resolve()),'sha256':sha(args.r1_amendment)})
    else:
        assert current['source_files']['stratolink.kicad_sch'] == previous['source_files']['stratolink.kicad_sch']
        assert old_bom == new_bom and len(new_bom) == 57
    assert set(new_cpl) == set(new_bom)
    body_audit = read(args.body_audit)
    assert body_audit['source_pcb_sha256'] == args.pcb_sha256, 'Body-clearance audit is stale'
    assert body_audit['result'] == 'PASS', 'Body-clearance audit has unresolved findings'
    assert set(body_audit['fitted_refs']) == set(new_bom), 'Body audit does not cover exact fitted population'
    if r1_amendment:
        assert body_audit['fitted_parts'] == {ref:{'mpn':row['Comment'],'lcsc':row['LCSC Part #']}
                                            for ref,row in new_bom.items()}, 'Body audit BOM identity mismatch'
    changed = {ref: {'before': old_cpl[ref], 'after': new_cpl[ref]}
               for ref in new_cpl if new_cpl[ref] != old_cpl[ref]}
    assert set(changed) == set(args.moved), sorted(changed)
    for ref, change in changed.items():
        assert {k:v for k,v in change['before'].items() if k not in {'Mid X','Mid Y'}} == {
            k:v for k,v in change['after'].items() if k not in {'Mid X','Mid Y'}}, ref
    assert new_cpl['U1']['Layer'] == 'bottom' and new_cpl['U1']['Rotation'] == '270.000000'
    assert new_cpl['U8']['Layer'] == 'top' and new_cpl['U8']['Rotation'] == '90.000000'
    assert {'C15','R21','R19','C14','C23','R27'} <= set(new_bom) and 'U6' not in new_bom
    assert collections.Counter(row['Layer'] for row in new_cpl.values()) == {'top':41,'bottom':16}
    app = wx.App(False)
    board = pcbnew.LoadBoard(str(SOURCE / 'stratolink.kicad_pcb'))
    via_delta = verify_added_via(board)
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        if ref not in new_cpl:
            continue
        pads = [p.GetBoundingBox() for p in fp.Pads()
                if p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD and p.IsOnLayer(fp.GetLayer())]
        x = (min(p.GetLeft() for p in pads) + max(p.GetRight() for p in pads)) / 2e6
        y = (min(p.GetTop() for p in pads) + max(p.GetBottom() for p in pads)) / 2e6
        assert abs(float(new_cpl[ref]['Mid X'])-x)<0.000003, ref
        assert abs(float(new_cpl[ref]['Mid Y'])+y)<0.000003, ref
    spec = importlib.util.spec_from_file_location('stencil', ROOT / 'analysis/v1_1_release_20261012/as7331/manufacturing/test_stencil.py')
    stencil = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stencil)
    alterations = stencil.verify_native(SOURCE / 'stratolink.kicad_pcb', NEW / 'native/stencil/stratolink.kicad_pcb')
    assert len(alterations) == 16 and {r['ref'] for r in alterations} == {'U6'}
    paste = {suffix:stencil.verify_paste(NEW / 'native/full-design-paste' / ('stratolink-'+suffix),
                                         NEW / 'gerbers' / ('stratolink-'+suffix))
             for suffix in ('F_Paste.gtp','B_Paste.gbp')}
    finish = read(NEW / 'finish-proof.json')
    assert abs(finish['board_thickness_mm'] - 0.4)<1e-8
    stable = []
    for name in ('stratolink-Edge_Cuts.gm1','stratolink-NPTH.drl',
                 'stratolink-F_Silkscreen.gto','stratolink-B_Silkscreen.gbo'):
        assert artwork(OLD / 'gerbers' / name) == artwork(NEW / 'gerbers' / name), name
        stable.append(name)
    for name in ('stratolink-F_Silkscreen.gto','stratolink-B_Silkscreen.gbo'):
        assert not any(('D01*' in line or 'D03*' in line) and not line.startswith('G04')
                       for line in (NEW / 'gerbers' / name).read_text().splitlines()), name
    reuse = None
    if args.reuse_physical_proof:
        proof = read(args.reuse_physical_proof)
        assert r1_amendment and proof['result'] == 'PASS'
        assert proof['current_source_pcb_sha256'] == args.pcb_sha256
        assert proof['fresh_fabrication_zip_sha256'] == sha(NEW/'fabrication-review.zip')
        assert proof['required_new_bom_sha256'] == sha(NEW/'BOM-stratolink.csv')
        assert proof['cpl_byte_identical'] and proof['cpl_sha256'] == sha(NEW/'CPL-stratolink.csv')
        reuse = {'existing_uploaded_zip_sha256':proof['existing_uploaded_fabrication_zip_sha256'],
                 'fresh_generated_zip_sha256':proof['fresh_fabrication_zip_sha256'],
                 'proof':str(args.reuse_physical_proof.resolve()),'proof_sha256':sha(args.reuse_physical_proof),
                 'scope':proof['permitted_reuse']}
    report = {'result':'PASS', 'pcb_sha256':args.pcb_sha256, 'packages':packages,
              'assembly_count':57,'side_counts':{'top':41,'bottom':16},
              'body_clearance_audit':{'path':str(args.body_audit.resolve()),'sha256':sha(args.body_audit),
                                      'result':body_audit['result'],'fitted_count':len(body_audit['fitted_refs'])},
              'bom_identical_to_previous':old_bom==new_bom,
              'schematic_hash_unchanged':current['source_files']['stratolink.kicad_sch']==previous['source_files']['stratolink.kicad_sch'],
              'schematic_netmap_unchanged':True,'r1_procurement_amendment':r1_amendment,
              'equivalent_existing_fabrication_upload':reuse,
              'legacy_download_archives_preserved': {name:item['sha256']
                  for name,item in legacy_download_manifest['archives'].items()},
              'cpl_changed_rows':changed,'stencil_u6_only_pad_changes':len(alterations),
              'paste':paste,'unchanged_outline_npth_silk':stable,'explicit_pth_via_delta':via_delta,
              'source_differences':{name:{'previous':previous['source_files'].get(name),'current':digest}
                  for name,digest in current['source_files'].items() if previous['source_files'].get(name)!=digest},
              'limits':'Package consistency and intended export scope. DRC, body clearance, electrical performance, supplier CAM and real assembly remain separate reviews.'}
    (HERE / 'verification.json').write_text(json.dumps(report,indent=2)+'\n')
    upload = {'package':str(NEW.relative_to(ROOT)),'source_pcb_sha256':args.pcb_sha256,
              'files':{name:sha(NEW/name) for name in ('fabrication-review.zip','BOM-stratolink.csv','CPL-stratolink.csv')},
              'population':'57 fitted references; C15/R21 fitted; only U6 omitted from SMT',
              'r1':{'mpn':new_bom['R1']['Comment'],'lcsc':new_bom['R1']['LCSC Part #']},
              'equivalent_existing_fabrication_upload':reuse,
              'u1_orientation':'Pin 1 upper-left in bottom-facing, board-top-up view. Reconfirm replacement-order preview.',
              'status':'Prepared for new-order review; no supplier upload or production approval by this script.'}
    (HERE / 'upload-manifest.json').write_text(json.dumps(upload,indent=2)+'\n')
    print(json.dumps(upload,indent=2))


if __name__ == '__main__':
    main()
