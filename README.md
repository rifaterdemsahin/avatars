# 🤖 Avatar Slicer & Bot Generator

> Slice any multi-avatar image / sprite sheet into individual bot avatars, or generate fresh procedural AI bot avatar sheets on the fly. 100% client-side, zero backend required.

🔗 **Live GitHub Pages Web App**: [https://rifaterdemsahin.github.io/avatars/](https://rifaterdemsahin.github.io/avatars/)

---

## ✨ Features

- **Procedural Bot Generator**: Generate high-res grids of distinctive cybernetic robot avatars with antennas, visor styles, glowing cores, and color palettes right in the browser.
- **Precision Grid Slicer**: Cut any uploaded or generated image by rows & columns (2×2, 3×3, 4×4, 5×5, or custom grids up to 10×10).
- **Custom Margins & Gutters**: Fine-tune outer margins and inner gutters between avatar tiles.
- **Live Visual Slicing Overlay**: Real-time canvas preview displaying animated cut borders, coordinate labels, and hover inspection.
- **Bot Codename Generator**: Automatically assigns names (`Nexus-01`, `Aegis-02`, etc.) or supports custom naming prefixes.
- **Preview Modes**: Toggle between Square and Circular (chat/Discord style with online status indicator).
- **Export Options**:
  - **Download All as ZIP** with one click.
  - Download individual PNG, WebP, or JPEG files.
  - Copy directly to clipboard as PNG blob.
  - Optional downscaling/upscaling (Original, 512×512, 256×256, 128×128, 64×64).

---

## 🚀 Local Development

To run locally on a custom port (e.g. `30090`):

```bash
# Start local static server
python3 -m http.server 30090

# Open in Google Chrome
open -a "Google Chrome" http://localhost:30090
```

To re-generate the high-resolution 3×3 sample bot sheet:
```bash
python3 scripts/generate_sample_sheet.py
```

---

## 📦 Deployment

Hosted directly on GitHub Pages from the `main` branch:
[https://rifaterdemsahin.github.io/avatars/](https://rifaterdemsahin.github.io/avatars/)
