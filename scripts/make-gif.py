#!/usr/bin/env python3
"""Assembles frames captured by capture-demo.mjs into assets/demo.gif.
Requires Pillow: pip install Pillow
"""
import json
import os
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = "/tmp/demo-frames"
OUT_PATH = os.path.join(SCRIPT_DIR, "..", "assets", "demo.gif")
TARGET_WIDTH = 760  # downscale from the 1000px capture width for a reasonable file size

with open(f"{FRAMES_DIR}/manifest.json") as f:
    manifest = json.load(f)

images = []
durations = []
for entry in manifest:
    img = Image.open(f"{FRAMES_DIR}/{entry['file']}").convert("RGB")
    ratio = TARGET_WIDTH / img.width
    img = img.resize((TARGET_WIDTH, int(img.height * ratio)), Image.LANCZOS)
    images.append(img)
    durations.append(entry["holdMs"])

# Build one shared adaptive palette from the first (most representative) frame so
# colors stay consistent across frames instead of each being quantized independently.
base = images[0].quantize(colors=256, method=Image.MEDIANCUT)
quantized = [img.quantize(palette=base, dither=Image.FLOYDSTEINBERG) for img in images]

quantized[0].save(
    OUT_PATH,
    save_all=True,
    append_images=quantized[1:],
    duration=durations,
    loop=0,
    optimize=True,
)

size_kb = os.path.getsize(OUT_PATH) / 1024
print(f"Wrote {OUT_PATH} ({size_kb:.0f} KB, {len(images)} frames, {sum(durations)/1000:.1f}s)")
