# Reproducing the November 8 review

Run from the repository root. Use KiCad 10.0.0 CLI and its bundled Python (`pcbnew`, `wx`), plus a separate Python environment with Shapely 2.1.2. The recorded analysis environment is `analysis/.venv/bin/python`. Matplotlib 3.10.9 is needed only for the optional comparison plots. Existing helpers under the October analysis directories are tracked dependencies; no CAD snapshots or browser/email records need to be committed again.

## Restore captured inputs without overwriting files

This restores only local analysis inputs, never canonical hardware. The original PCB, schematic, rules/tables and footprint libraries come from `46264ef`. The captured project file comes from `320fc08`, which includes the preserved editor settings. The R1 pre-substitution source also comes from `320fc08`.

Every Git blob must match the recorded SHA-256. Existing files must already match; the script refuses to overwrite a differing file. New files use exclusive creation.

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json, subprocess
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
review = root / 'analysis/v1_1_resubmit_20261108'
def restore(commit, name, destination, expected):
    data = subprocess.check_output(['git', 'show', f'{commit}:hardware/pcb/{name}'], cwd=root)
    assert hashlib.sha256(data).hexdigest() == expected, (commit, name, 'Git blob mismatch')
    if destination.exists():
        assert destination.read_bytes() == data, (destination, 'existing file differs; left untouched')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as handle:
            handle.write(data)
    print('verified', destination.relative_to(root))
for name, digest in json.loads((review / 'layout/input-hashes.json').read_text()).items():
    commit = '320fc08' if name == 'stratolink.kicad_pro' else '46264ef'
    restore(commit, name, review / 'layout/before' / name, digest)
for name, entry in json.loads((review / 'r1-procurement/property-diff.json').read_text())['files'].items():
    restore('320fc08', name, review / 'r1-procurement/before' / name, entry['before_sha256'])
PY
```

The pre-R1 corrected PCB is also available in commit `31b97c7` or `320fc08` at `hardware/pcb/stratolink.kicad_pcb`. Original and corrected geometry hashes are recorded in `layout/promotion.json`; current R1-amended hashes are in `r1-procurement/verification.json`. Do not rerun `prepare.py` over an existing snapshot or run `apply.py` on the already-amended canonical files.

## Key checks

The scripts below refresh generated reports but do not edit canonical CAD. They currently name the macOS KiCad installation and `analysis/.venv`; adjust those executable paths if using another installation. Keep a copy of any locally modified report before regenerating it.

```sh
python3 analysis/v1_1_resubmit_20261108/verify_connectivity.py

/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 \
  analysis/v1_1_peer_review_20261014/power/snapshot_assembly.py \
  hardware/pcb/stratolink.kicad_pcb \
  analysis/v1_1_resubmit_20261108/assembly-review/final-native.json
python3 analysis/v1_1_resubmit_20261108/assembly-review/audit.py \
  --native analysis/v1_1_resubmit_20261108/assembly-review/final-native.json \
  --pcb hardware/pcb/stratolink.kicad_pcb \
  --bom hardware/gerbers/v1.1-resubmit-20261108/BOM-stratolink.csv \
  --output analysis/v1_1_resubmit_20261108/assembly-review/final-clearance.json

/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli pcb drc \
  --format json --all-track-errors --schematic-parity --severity-all \
  --exit-code-violations --refill-zones \
  --output analysis/v1_1_resubmit_20261108/drc-rerun.json \
  hardware/pcb/stratolink.kicad_pcb
/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli sch erc \
  --format json --severity-all --exit-code-violations \
  --output analysis/v1_1_resubmit_20261108/erc-rerun.json \
  hardware/pcb/stratolink.kicad_sch
```

Do not add `--save-board` to the DRC command. Expected results are 59 connected copper nets, no foreign-net overlaps, no DRC/unconnected/parity findings, and 940 passing same-face assembly pairs. ERC reports the two existing excluded warnings and returns code 5 when exclusions are included; verify both have `excluded: true` and that there are no other findings.

For the release/export checks, use the commands in [manufacturing/README.md](manufacturing/README.md). Preserve the dated manufacturing folder: its exporter deliberately refuses to overwrite it. The five `hardware/gerbers/v1.1-resubmit-20261108/logs/*.log` files and the two manufacturing profile JSON files are manifest dependencies even though generic log ignore rules hide the logs. Download verification is `python3 hardware/downloads/build.py --check`.
