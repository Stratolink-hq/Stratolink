#!/usr/bin/env python3
"""Run the established manufacturing generator after explicit candidate hash check."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / 'hardware/pcb'
OUTPUT = ROOT / 'hardware/gerbers/v1.1-resubmit-20261108'
KPY = '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pcb-sha256', required=True)
    args = parser.parse_args()
    pcb = SOURCE / 'stratolink.kicad_pcb'
    actual = hashlib.sha256(pcb.read_bytes()).hexdigest()
    if actual != args.pcb_sha256:
        raise SystemExit('Candidate PCB changed; review and supply its exact SHA-256.')
    command = [KPY, str(ROOT / 'analysis/v1_1_release_20261012/manufacturing/generate.py'),
               '--candidate', str(SOURCE), '--output', str(OUTPUT),
               '--finish', 'green-mask-no-silk',
               '--supplier-rotation-profile', str(HERE / 'supplier-rotation-profile.json'),
               '--population-profile', str(HERE / 'population-profile.json')]
    for ref in ('R1', 'R4', 'U2', 'U6'):
        command += ['--allow-part-change', ref]
    (HERE / 'export-command.json').write_text(json.dumps(command, indent=2) + '\n')
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    (HERE / 'export.stdout.txt').write_text(result.stdout)
    (HERE / 'export.stderr.txt').write_text(result.stderr)
    print(result.stdout)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
    assert hashlib.sha256(pcb.read_bytes()).hexdigest() == actual


if __name__ == '__main__':
    main()
