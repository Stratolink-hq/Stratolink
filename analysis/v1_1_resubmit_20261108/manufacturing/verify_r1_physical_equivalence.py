#!/usr/bin/env python3
"""Prove the uploaded pre-R1 fabrication ZIP still describes the amended board.

Reads the committed pre-amendment release, without modifying either package.
Only creation timestamps are normalized. BOM replacement is still required.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PACKAGE = Path('hardware/gerbers/v1.1-resubmit-20261108')
BASE = '320fc08'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def original(commit, name):
    return subprocess.check_output(['git','show',f'{commit}:{PACKAGE / name}'],cwd=ROOT)


def normalize(name, data):
    if name.endswith('.gbrjob'):
        value = json.loads(data)
        assert isinstance(value['Header'].pop('CreationDate'), str)
        return json.dumps(value,sort_keys=True).encode()
    ignored = (r'%TF\.CreationDate,[^*]+\*%',
               r'G04 Created by KiCad \(PCBNEW 10\.0\.0\) date [^*]+\*',
               r'; DRILL file KiCad 10\.0\.0 date .+',r'; #@! TF\.CreationDate,.+')
    return '\n'.join(line for line in data.decode().splitlines()
                     if not any(re.fullmatch(pattern,line) for pattern in ignored)).encode()


def main():
    commit = subprocess.check_output(['git','rev-parse',BASE],cwd=ROOT,text=True).strip()
    old_manifest = json.loads(original(commit,'manifest.json'))
    new_manifest = json.loads((ROOT/PACKAGE/'manifest.json').read_text())
    old_data = original(commit,'fabrication-review.zip')
    new_data = (ROOT/PACKAGE/'fabrication-review.zip').read_bytes()
    assert sha(old_data) == old_manifest['output_files']['fabrication-review.zip'] == '3d6e5ee781fe8c57edb24daa790908430d78d4476ae0c5875e60102f4f7cb85c'
    assert sha(new_data) == new_manifest['output_files']['fabrication-review.zip']
    files = {}
    with zipfile.ZipFile(io.BytesIO(old_data)) as old, zipfile.ZipFile(io.BytesIO(new_data)) as new:
        assert len(old.namelist()) == len(new.namelist()) == 12
        assert set(old.namelist()) == set(new.namelist())
        for name in sorted(old.namelist()):
            before, after = old.read(name), new.read(name)
            assert sha(before) == old_manifest['output_files']['gerbers/'+name]
            assert sha(after) == new_manifest['output_files']['gerbers/'+name]
            assert normalize(name,before) == normalize(name,after), name
            files[name] = {'previous_sha256':sha(before),'current_sha256':sha(after),
                           'timestamp_normalized_sha256':sha(normalize(name,after))}
    old_cpl = original(commit,'CPL-stratolink.csv')
    new_cpl = (ROOT/PACKAGE/'CPL-stratolink.csv').read_bytes()
    assert old_cpl == new_cpl
    report = {'result':'PASS','baseline_git_commit':commit,
              'previous_source_pcb_sha256':old_manifest['source_files']['stratolink.kicad_pcb'],
              'current_source_pcb_sha256':new_manifest['source_files']['stratolink.kicad_pcb'],
              'existing_uploaded_fabrication_zip_sha256':sha(old_data),
              'fresh_fabrication_zip_sha256':sha(new_data),
              'normalization':'Creation timestamps only; all other content compared exactly.',
              'fabrication_files':files,'cpl_byte_identical':True,'cpl_sha256':sha(new_cpl),
              'required_new_bom_sha256':sha((ROOT/PACKAGE/'BOM-stratolink.csv').read_bytes()),
              'permitted_reuse':'Existing uploaded fabrication ZIP may be retained. Replace BOM with the amended R1 selection; CPL is byte-identical. This does not approve supplier CAM or placement.'}
    (HERE/'r1-physical-equivalence.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='fabrication_files'},indent=2))


if __name__ == '__main__':
    main()
