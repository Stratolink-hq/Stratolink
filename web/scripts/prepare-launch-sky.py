"""Build the homepage sky plate (public/assets/launch/sky.webp) at the photograph's full 2560 × 1440.

The inpainted plate (sky.png, 1672 × 941) supplies the sky's colour and gradient everywhere, so the page keeps its
look, including where the city, clouds and balloon hide the photograph. Wherever the photograph shows clear sky,
its own detail and grain are laid on top; elsewhere synthetic grain keeps the texture even. The grain stops WebP
from flattening the smooth gradient into blotches when phones scale the plate up.

Usage: python3 scripts/prepare-launch-sky.py /path/to/IMG_3466.jpg [--quality 90]
Requires numpy, Pillow and cwebp.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

LAUNCH = Path(__file__).resolve().parent.parent / 'public' / 'assets' / 'launch'
SIZE = (2560, 1440)
COLOUR_RADIUS = 40  # px: coarser than this comes from the plate, finer from the photograph
# WebP keeps only about half of the photograph's fine grain, so the synthetic grain is set to half strength to
# match it after encoding; at full strength the hidden areas (e.g. behind the balloon) read as coarser patches.
GRAIN = .5


def blur(array, sigma):
    """Gaussian blur of a float H×W×C array (FFT, edges mirrored so the sky can't wrap into the skyline)."""
    pad = int(3 * sigma) + 1
    padded = np.pad(array, ((pad, pad), (pad, pad), (0, 0)), mode='reflect')
    h, w = padded.shape[:2]
    kernel = np.exp(-2 * (np.pi * sigma) ** 2 * (np.fft.fftfreq(h)[:, None] ** 2 + np.fft.rfftfreq(w)[None, :] ** 2))
    out = np.stack([np.fft.irfft2(np.fft.rfft2(padded[..., c]) * kernel, s=(h, w)) for c in range(array.shape[-1])], -1)
    return out[pad:-pad, pad:-pad].astype(np.float32)


def mask(name, threshold=.02):
    alpha = Image.open(LAUNCH / name).getchannel('A').resize(SIZE, Image.BILINEAR)
    return np.asarray(alpha, dtype=np.float32) / 255 > threshold


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('photo', type=Path, help='the original 2560 × 1440 launch photograph')
    parser.add_argument('--quality', type=int, default=90)
    args = parser.parse_args()

    photo = np.asarray(Image.open(args.photo).convert('RGB'), dtype=np.float32)
    if photo.shape[:2] != SIZE[::-1]:
        raise SystemExit(f'expected a {SIZE[0]} × {SIZE[1]} photograph, got {photo.shape[1]} × {photo.shape[0]}')
    plate = np.asarray(Image.open(LAUNCH / 'sky.png').convert('RGB').resize(SIZE, Image.LANCZOS), dtype=np.float32)

    # Clear sky: outside the city/cloud and balloon masks, pulled back from their edges. The balloon mask stops
    # short of the envelope's bright rim, so it gets a much wider margin.
    grow = lambda m, size: np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(size))) > 127
    clear = ~(grow(mask('city-mask.png'), 9) | grow(mask('balloon-mask.png'), 41))
    weight = np.asarray(Image.fromarray((clear * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6)),
                        dtype=np.float32)[..., None] / 255

    # Photograph detail, measured against a low-pass taken only over clear sky (so clouds can't halo into it).
    clear3 = clear[..., None].astype(np.float32)
    photo_low = blur(photo * clear3, COLOUR_RADIUS) / np.maximum(blur(clear3, COLOUR_RADIUS), 1e-3)
    detail = photo - photo_low

    # Synthetic grain with the photograph's strength, mostly shared across channels like the real grain.
    rng = np.random.default_rng(3466)
    grain = rng.normal(0, 1, (SIZE[1], SIZE[0], 1)) * .9 + rng.normal(0, 1, (SIZE[1], SIZE[0], 3)) * .45
    grain = blur(grain.astype(np.float32), .6)
    real = detail[clear] - blur(detail, 3)[clear]
    synthetic = grain - blur(grain, 3)
    grain *= real.std(0) / synthetic.reshape(-1, 3).std(0) * GRAIN

    sky = blur(plate, COLOUR_RADIUS) + weight * detail + (1 - weight) * (plate - blur(plate, COLOUR_RADIUS) + grain)
    out = Image.fromarray(np.clip(sky + .5, 0, 255).astype(np.uint8))
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / 'sky.png'
        out.save(png)
        subprocess.run(['cwebp', '-quiet', '-q', str(args.quality), '-m', '6', '-sharp_yuv', str(png),
                        '-o', str(LAUNCH / 'sky.webp')], check=True)
    print(f'sky.webp: {SIZE[0]} × {SIZE[1]}, clear sky {clear.mean():.0%} from the photograph, '
          f'{(LAUNCH / "sky.webp").stat().st_size / 1024:.0f} KB at quality {args.quality}')


if __name__ == '__main__':
    main()
