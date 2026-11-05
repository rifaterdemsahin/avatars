#!/usr/bin/env python3
"""
Slice sample_avatars.jpeg (2048x2048) into 16 individual bot avatar images (512x512).
Saves images into avatars/ named bot-01.png through bot-16.png.
"""

import os
import json
from PIL import Image

def slice_avatar_sheet():
    input_path = "assets/sample_avatars.jpeg"
    if not os.path.exists(input_path):
        input_path = "assets/sample_avatar.jpeg"
    
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Cannot find source image at assets/sample_avatars.jpeg")

    out_dir = "avatars"
    os.makedirs(out_dir, exist_ok=True)

    img = Image.open(input_path)
    width, height = img.size
    cols = 4
    rows = 4
    cell_w = width // cols
    cell_h = height // rows

    manifest = []
    print(f"Loaded {input_path} ({width}x{height}). Slicing into {rows}x{cols} ({cell_w}x{cell_h} each)...")

    # Bot AI codenames
    codenames = [
        "Aegis", "Nexus", "Echo", "Vortex",
        "Cypher", "Zenith", "Pulse", "Specter",
        "Orion", "Titan", "Apex", "Vector",
        "Nova", "Glitch", "Spark", "Quantum"
    ]

    for r in range(rows):
        for c in range(cols):
            index = r * cols + c + 1
            left = c * cell_w
            top = r * cell_h
            right = left + cell_w
            bottom = top + cell_h

            crop = img.crop((left, top, right, bottom))
            filename = f"bot-{index:02d}.png"
            file_path = os.path.join(out_dir, filename)
            crop.save(file_path, "PNG", optimize=True)

            bot_info = {
                "id": index,
                "name": f"bot-{index:02d}",
                "codename": codenames[index - 1],
                "filename": filename,
                "path": f"avatars/{filename}",
                "row": r + 1,
                "col": c + 1,
                "width": cell_w,
                "height": cell_h
            }
            manifest.append(bot_info)
            print(f"  [+] Saved {file_path} ({cell_w}x{cell_h}) - {codenames[index - 1]}")

    # Save manifest.json
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump({"total": len(manifest), "avatars": manifest}, f, indent=2)

    print(f"\nSuccessfully created {len(manifest)} avatars in '{out_dir}/' and saved manifest.")

if __name__ == "__main__":
    slice_avatar_sheet()
