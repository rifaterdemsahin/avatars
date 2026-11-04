"""
Script to generate a 3x3 high-resolution sample bot avatar sheet (1536x1536).
Each cell (512x512) contains a distinctive, colorful robot avatar.
"""

import math
from PIL import Image, ImageDraw

def create_bot_avatar(draw, origin_x, origin_y, size, bot_id):
    ox, oy = origin_x, origin_y
    cx, cy = ox + size // 2, oy + size // 2

    # Palettes for 9 different bots
    palettes = [
        # 0: Cyber Cyan / Neon Blue
        {"bg": (15, 23, 42), "body": (30, 41, 59), "accent": (6, 182, 212), "glow": (34, 211, 238), "eye": (255, 255, 255), "style": "cyber"},
        # 1: Neon Purple / Violet
        {"bg": (26, 16, 49), "body": (59, 29, 97), "accent": (168, 85, 247), "glow": (216, 180, 254), "eye": (244, 114, 182), "style": "visor"},
        # 2: Emerald Matrix / Green
        {"bg": (6, 30, 20), "body": (16, 60, 42), "accent": (16, 185, 129), "glow": (52, 211, 153), "eye": (167, 243, 208), "style": "mech"},
        # 3: Solar Amber / Gold
        {"bg": (41, 25, 6), "body": (78, 48, 12), "accent": (245, 158, 11), "glow": (251, 191, 36), "eye": (254, 243, 199), "style": "retro"},
        # 4: Crimson / Ruby Mech
        {"bg": (38, 10, 16), "body": (76, 20, 31), "accent": (239, 68, 68), "glow": (248, 113, 113), "eye": (254, 202, 202), "style": "cyclops"},
        # 5: Bubblegum Synthwave / Pink
        {"bg": (36, 15, 38), "body": (73, 27, 78), "accent": (236, 72, 153), "glow": (244, 114, 182), "eye": (147, 197, 253), "style": "cute"},
        # 6: Electric Indigo / Android
        {"bg": (17, 24, 60), "body": (39, 49, 107), "accent": (99, 102, 241), "glow": (129, 140, 248), "eye": (224, 231, 255), "style": "sleek"},
        # 7: Lime Radioactive / Hacker
        {"bg": (19, 31, 12), "body": (36, 59, 23), "accent": (132, 204, 22), "glow": (163, 230, 53), "eye": (236, 252, 203), "style": "visor"},
        # 8: Obsidian Stealth / Orange Flare
        {"bg": (20, 20, 22), "body": (42, 42, 46), "accent": (249, 115, 22), "glow": (251, 146, 60), "eye": (254, 215, 170), "style": "stealth"},
    ]

    p = palettes[bot_id % len(palettes)]

    # 1. Background with radial/circular accent
    draw.rectangle([ox, oy, ox + size, oy + size], fill=p["bg"])
    
    # Background subtle grid/lines
    for step in range(ox, ox + size, 32):
        draw.line([step, oy, step, oy + size], fill=(p["bg"][0] + 8, p["bg"][1] + 8, p["bg"][2] + 12), width=1)
    for step in range(oy, oy + size, 32):
        draw.line([ox, step, ox + size, step], fill=(p["bg"][0] + 8, p["bg"][1] + 8, p["bg"][2] + 12), width=1)

    # Background ambient circle glow
    glow_r = 170
    draw.ellipse([cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r], 
                 outline=p["accent"], width=3)
    glow_r2 = 185
    draw.ellipse([cx - glow_r2, cy - glow_r2, cx + glow_r2, cy + glow_r2], 
                 outline=(p["body"][0] + 10, p["body"][1] + 10, p["body"][2] + 15), width=1)

    # 2. Torso / Shoulders
    torso_top = cy + 110
    torso_w = 170
    draw.rectangle([cx - torso_w, torso_top, cx + torso_w, oy + size], fill=p["body"])
    draw.rectangle([cx - torso_w, torso_top, cx + torso_w, oy + size], outline=p["accent"], width=4)

    # Reactor / Core on chest
    core_y = torso_top + 45
    draw.ellipse([cx - 28, core_y - 28, cx + 28, core_y + 28], fill=p["glow"], outline=(255, 255, 255), width=3)
    draw.ellipse([cx - 14, core_y - 14, cx + 14, core_y + 14], fill=(255, 255, 255))

    # Neck
    neck_w = 46
    draw.rectangle([cx - neck_w, cy + 70, cx + neck_w, torso_top + 10], fill=(45, 55, 72), outline=p["accent"], width=2)
    for ny in range(cy + 75, torso_top, 8):
        draw.line([cx - neck_w + 4, ny, cx + neck_w - 4, ny], fill=(100, 116, 139), width=2)

    # 3. Ears / Side Sensors
    ear_w = 20
    ear_h = 60
    head_w = 120
    head_h = 100
    head_top = cy - 70

    # Side bolts / antennas
    draw.rectangle([cx - head_w - ear_w, head_top + 35, cx - head_w, head_top + 35 + ear_h], fill=p["accent"])
    draw.rectangle([cx + head_w, head_top + 35, cx + head_w + ear_w, head_top + 35 + ear_h], fill=p["accent"])
    
    # Antenna style
    if p["style"] in ["cyber", "retro", "stealth"]:
        # Dual top antennas with glowing balls
        ant_len = 55
        draw.line([cx - 50, head_top, cx - 70, head_top - ant_len], fill=p["accent"], width=6)
        draw.ellipse([cx - 78, head_top - ant_len - 14, cx - 62, head_top - ant_len + 2], fill=p["glow"])
        draw.line([cx + 50, head_top, cx + 70, head_top - ant_len], fill=p["accent"], width=6)
        draw.ellipse([cx + 62, head_top - ant_len - 14, cx + 78, head_top - ant_len + 2], fill=p["glow"])
    elif p["style"] in ["visor", "sleek"]:
        # Center crest / radar fin
        draw.polygon([(cx, head_top - 60), (cx - 24, head_top), (cx + 24, head_top)], fill=p["accent"])
        draw.ellipse([cx - 10, head_top - 50, cx + 10, head_top - 30], fill=p["glow"])
    else:
        # Dish / single antenna
        draw.line([cx, head_top, cx, head_top - 55], fill=p["accent"], width=6)
        draw.ellipse([cx - 16, head_top - 70, cx + 16, head_top - 50], fill=p["glow"], outline=(255, 255, 255), width=2)

    # 4. Robot Head shape
    head_rect = [cx - head_w, head_top, cx + head_w, head_top + head_h * 2 - 10]
    draw.rounded_rectangle(head_rect, radius=28, fill=p["body"], outline=p["accent"], width=6)

    # Forehead plate / decorative panel
    draw.rectangle([cx - head_w + 30, head_top + 12, cx + head_w - 30, head_top + 26], fill=(p["body"][0] + 30, p["body"][1] + 30, p["body"][2] + 40))
    for px in range(cx - 30, cx + 40, 20):
        draw.ellipse([px - 3, head_top + 16, px + 3, head_top + 22], fill=p["glow"])

    # 5. Eyes / Visor according to style
    eye_y = head_top + 65
    if p["style"] in ["visor", "stealth"]:
        # Continuous glowing visor bar
        draw.rounded_rectangle([cx - 85, eye_y - 12, cx + 85, eye_y + 24], radius=10, fill=(10, 10, 15), outline=p["accent"], width=3)
        draw.rounded_rectangle([cx - 78, eye_y - 6, cx + 78, eye_y + 18], radius=8, fill=p["glow"])
        # Visor glare reflection
        draw.polygon([(cx - 40, eye_y - 4), (cx - 20, eye_y - 4), (cx - 50, eye_y + 16), (cx - 70, eye_y + 16)], fill=(255, 255, 255, 180))
    elif p["style"] == "cyclops":
        # Huge central camera eye
        draw.ellipse([cx - 48, eye_y - 25, cx + 48, eye_y + 40], fill=(15, 23, 42), outline=p["accent"], width=5)
        draw.ellipse([cx - 32, eye_y - 15, cx + 32, eye_y + 30], fill=p["glow"])
        draw.ellipse([cx - 16, eye_y - 5, cx + 16, eye_y + 20], fill=p["eye"])
        draw.ellipse([cx + 2, eye_y - 2, cx + 10, eye_y + 6], fill=(255, 255, 255))
    elif p["style"] == "retro":
        # Square pixel LED eyes
        draw.rectangle([cx - 75, eye_y - 10, cx - 25, eye_y + 25], fill=(10, 10, 10), outline=p["accent"], width=3)
        draw.rectangle([cx + 25, eye_y - 10, cx + 75, eye_y + 25], fill=(10, 10, 10), outline=p["accent"], width=3)
        # LED matrix dots
        for r in range(3):
            for c in range(3):
                draw.ellipse([cx - 65 + c * 16, eye_y - 4 + r * 10, cx - 55 + c * 16, eye_y + 2 + r * 10], fill=p["glow"])
                draw.ellipse([cx + 35 + c * 16, eye_y - 4 + r * 10, cx + 45 + c * 16, eye_y + 2 + r * 10], fill=p["glow"])
    elif p["style"] == "cute":
        # Curved happy kawaii eyes
        draw.arc([cx - 75, eye_y - 15, cx - 25, eye_y + 25], start=180, end=360, fill=p["glow"], width=9)
        draw.arc([cx + 25, eye_y - 15, cx + 75, eye_y + 25], start=180, end=360, fill=p["glow"], width=9)
        # Blush stickers
        draw.ellipse([cx - 85, eye_y + 30, cx - 60, eye_y + 44], fill=(244, 114, 182))
        draw.ellipse([cx + 60, eye_y + 30, cx + 85, eye_y + 44], fill=(244, 114, 182))
    else:
        # Standard Dual High-Tech Circular Eyes
        for sign in [-1, 1]:
            ex = cx + sign * 50
            draw.ellipse([ex - 28, eye_y - 15, ex + 28, eye_y + 30], fill=(15, 23, 42), outline=p["accent"], width=4)
            draw.ellipse([ex - 18, eye_y - 6, ex + 18, eye_y + 22], fill=p["glow"])
            draw.ellipse([ex - 9, eye_y + 1, ex + 9, eye_y + 15], fill=p["eye"])
            # Pupil reflection
            draw.ellipse([ex + 2, eye_y + 2, ex + 7, eye_y + 7], fill=(255, 255, 255))

    # 6. Mouth / Grill / Audio visualizer
    mouth_y = head_top + 130
    draw.rounded_rectangle([cx - 55, mouth_y, cx + 55, mouth_y + 24], radius=6, fill=(10, 15, 25), outline=p["accent"], width=2)
    # Speaker vertical bars
    for bar_x in range(cx - 45, cx + 50, 12):
        draw.line([bar_x, mouth_y + 5, bar_x, mouth_y + 19], fill=p["glow"], width=4)

    # 7. Corner Bot ID Badge
    badge_text = f"BOT-{bot_id+1:02d}"
    # Small corner accent
    draw.rectangle([ox + 16, oy + 16, ox + 110, oy + 42], fill=(15, 23, 42), outline=p["accent"], width=2)
    # Status light
    draw.ellipse([ox + 26, oy + 24, ox + 36, oy + 34], fill=p["glow"])

def main():
    width = 1536
    height = 1536
    cell_size = 512
    img = Image.new("RGB", (width, height), (10, 15, 30))
    draw = ImageDraw.Draw(img)

    for row in range(3):
        for col in range(3):
            bot_id = row * 3 + col
            ox = col * cell_size
            oy = row * cell_size
            create_bot_avatar(draw, ox, oy, cell_size, bot_id)

    # Save to assets/sample-bot-sheet.png
    out_path = "assets/sample-bot-sheet.png"
    img.save(out_path, "PNG")
    print(f"Generated sample bot avatar sheet at {out_path} ({width}x{height})")

if __name__ == "__main__":
    main()
