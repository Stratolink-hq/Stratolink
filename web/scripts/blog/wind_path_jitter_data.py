"""Data for the blog post's "How much jitter?" figure: the 201-hour gap reconstructed
across a grid of the long-gap smoother's perturbation settings.

The runs come from a sweep of `reconstructLongGap` (lib/wind/pathReconstructionLongGap.ts)
on stratolink-3's 201 h gap with its production-equivalent .slwc v5 reconstruction cube,
8,000 particles per filter, with CFG.DIR_SIGMA_DEG / SPEED_SIGMA / PRESSURE_SIGMA_HPA
overridden per run (heading 4/8/12/18/24°, speed 5/10/15/22/30 %, pressure 2/5/8/12/16 hPa,
plus three extra seeds at the production 12° / 15 % / 8 hPa). Each run is one JSON:
  {dir, speed, press, seed, line: [[lat, lon]×101], draws: [[[lat, lon]×101]×150],
   evidence: {"100": …}, r90: [q1, mid, q3], angleP90, lineMethod}
where `evidence["100"]` is the mean, over 2,000 × 2,000 forward/backward pairs, of a
fixed 100 km Gaussian kernel on the pair's RMS separation across the overlap window:
how likely the two clouds are to meet under that setting.

usage: python3 wind_path_jitter_data.py <runs dir> <figure data dir>
writes <dir>/jitter.json and jitter.bin (Int16 lat, lon ×100: per cell the drawn line,
then 60 draws of 51 points), for the 25 heading × speed cells at 8 hPa.
"""
import json, glob, os, sys
import numpy as np

RUNS, OUT = sys.argv[1:3]
DIRS = [4, 8, 12, 18, 24]; SPEEDS = [0.05, 0.10, 0.15, 0.22, 0.30]; PRESS = 8; TODAY = (12, 0.15)
NDRAW, NPT = 60, 51
runs = {}
for f in glob.glob(os.path.join(RUNS, '*.json')):
    r = json.load(open(f)); runs[(r['dir'], round(r['speed'], 2), r['press'], r['seed'])] = r

def hav(a, b):
    a = np.radians(np.asarray(a, float)); b = np.radians(np.asarray(b, float))
    x = np.sin((b[:, 0] - a[:, 0]) / 2) ** 2 + np.cos(a[:, 0]) * np.cos(b[:, 0]) * np.sin((b[:, 1] - a[:, 1]) / 2) ** 2
    return 2 * 6371 * np.arcsin(np.sqrt(x))

today = runs[(*TODAY, PRESS, 1)]
seeds = [runs[k] for k in sorted(runs) if k[:3] == (*TODAY, PRESS)]
noise = [hav(seeds[i]['line'], seeds[j]['line']) for i in range(len(seeds)) for j in range(i + 1, len(seeds))]
cells, blob = [], bytearray()
idx = np.linspace(0, 100, NPT).round().astype(int)
for s in SPEEDS:
    for d in DIRS:
        r = runs[(d, s, PRESS, 1)]
        draws = np.array(r['draws'])[np.linspace(0, len(r['draws']) - 1, NDRAW).round().astype(int)][:, idx, :]
        off = len(blob) // 2
        blob += np.clip(np.rint(np.concatenate([np.ravel(r['line']), draws.ravel()]) * 100), -32767, 32767).astype('<i2').tobytes()
        shift = hav(r['line'], today['line'])
        cells.append({'dir': d, 'speed': s, 'off': off, 'score': round(r['evidence']['100'] / today['evidence']['100'], 2),
                      'shiftMed': int(round(float(np.median(shift)))), 'shiftMax': int(round(float(shift.max()))),
                      'r90': r['r90'][1], 'angle90': r['angleP90'], 'split': r['lineMethod'] != 'posterior-mean'})
meta = {'dirs': DIRS, 'speeds': SPEEDS, 'pressHpa': PRESS, 'today': {'dir': TODAY[0], 'speed': TODAY[1]}, 'nLine': 101, 'nDraw': NDRAW, 'nPt': NPT,
        'noise': {'median': int(round(float(np.median([np.median(n) for n in noise])))), 'max': int(round(float(max(n.max() for n in noise))))},
        'cells': cells}
open(os.path.join(OUT, 'jitter.bin'), 'wb').write(bytes(blob))
json.dump(meta, open(os.path.join(OUT, 'jitter.json'), 'w'), separators=(',', ':'))
print(len(cells), 'cells,', len(blob) // 1024, 'KB; rerun noise', meta['noise'], '; best score', max(c['score'] for c in cells))
