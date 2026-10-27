"""Record the D3 graphic as a video, frame by frame, in headless Chrome.

Serves this folder, opens index.html?capture=1 at 1080 × 1350, and for each frame
asks the page to seek its background video and redraw (window.renderFrame), then
screenshots it and pipes the PNGs to ffmpeg. The last frame is held for 3 s.

    python capture.py --style geocolor        # ../output/stratolink1_flight_geocolor.mp4
    python capture.py --style map --frames 0 300 560   # stills for checking, as PNGs
    python capture.py --serve 8765                     # just serve the page, for viewing it

Run export.py first. Needs Playwright (`pip install playwright`) and Google Chrome.
"""
from __future__ import annotations

import argparse
import functools
import re
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE.parent / "output"
W, H, FPS, HOLD_S = 1080, 1350, 30, 3


class Handler(SimpleHTTPRequestHandler):
    """Static files with byte ranges, which browsers need to seek in a video."""

    def log_message(self, *args):
        pass

    def send_head(self):
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        path = Path(self.translate_path(self.path))
        if not match or not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        start = int(match[1]) if match[1] else max(size - int(match[2] or 0), 0)
        end = min(int(match[2]) if match[1] and match[2] else size - 1, size - 1)
        if start > end:
            self.send_error(416)
            return None
        f = path.open("rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return _Slice(f, end - start + 1)


class _Slice:
    """The part of an open file a range covers, for copyfile."""

    def __init__(self, f, length):
        self.f, self.left = f, length

    def read(self, n=-1):
        n = self.left if n < 0 else min(n, self.left)
        data = self.f.read(n)
        self.left -= len(data)
        return data

    def close(self):
        self.f.close()


def serve(port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(HERE)))
    server.handle_error = lambda *args: None  # Chrome drops video range requests mid-stream when seeking
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main(style: str, frames: list[int] | None):
    from playwright.sync_api import sync_playwright
    OUT.mkdir(parents=True, exist_ok=True)
    server = serve()
    url = f"http://127.0.0.1:{server.server_port}/index.html?capture=1&style={style}"
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        page.on("console", lambda m: m.type == "error" and print("page:", m.text))
        page.goto(url)
        page.wait_for_function("window.ready === true", timeout=60_000)
        count = page.evaluate("window.frameCount")
        shot = lambda k: (page.evaluate(f"window.renderFrame({k})"),
                          page.screenshot(clip={"x": 0, "y": 0, "width": W, "height": H}))[1]
        if frames:
            for k in frames:
                path = OUT / f"flight_{style}_{k:04d}.png"
                path.write_bytes(shot(min(k, count - 1)))
                print(f"Wrote {path}")
            return
        mp4 = OUT / f"stratolink1_flight_{style}.mp4"
        ffmpeg = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS),
                                   "-i", "-", "-c:v", "libx264", "-crf", "17", "-preset", "slow",
                                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)], stdin=subprocess.PIPE)
        for k in range(count):
            png = shot(k)
            ffmpeg.stdin.write(png)
            if k % 100 == 0:
                print(f"  frame {k}/{count}")
        for _ in range(FPS * HOLD_S):
            ffmpeg.stdin.write(png)
        ffmpeg.stdin.close()
        if ffmpeg.wait():
            raise SystemExit("ffmpeg failed")
        browser.close()
        print(f"Wrote {mp4}")
    server.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--style", choices=["geocolor", "map"], default="geocolor")
    parser.add_argument("--frames", type=int, nargs="+", help="write these frames as PNGs instead of the video")
    parser.add_argument("--serve", type=int, metavar="PORT", help="serve the page on this port and do nothing else")
    args = parser.parse_args()
    if args.serve:
        print(f"Serving http://127.0.0.1:{args.serve}/")
        serve(args.serve).serve_forever()
    else:
        main(args.style, args.frames)
