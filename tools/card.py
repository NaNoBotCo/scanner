#!/usr/bin/env python3
"""Share card, 1200x630 JPEG: docs/card.jpg. Drawn with headless Chrome in the app's colours."""
import subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "card.jpg"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;background:#111417;color:#f5f4f1;position:relative;
 font-family:system-ui,-apple-system,"Noto Sans Thai",sans-serif}
.glow{position:absolute;inset:0;background:radial-gradient(40% 60% at 75% 50%,rgba(138,180,248,.16),transparent 70%)}
h1{position:absolute;left:72px;top:150px;font:800 124px/1 system-ui,-apple-system,sans-serif;letter-spacing:-.015em}
.sub{position:absolute;left:76px;top:304px;width:470px;font:400 34px/1.4 system-ui,-apple-system,sans-serif;color:#c9c6bf}
.tag{position:absolute;left:76px;top:470px;background:#1d5fb4;color:#fff;font:700 28px/1 system-ui,sans-serif;padding:20px 28px;border-radius:14px}
svg{position:absolute;right:0;top:0}
</style></head><body><div class="glow"></div>
<h1>Scanner</h1>
<div class="sub">Photograph pages, straighten them, and make a PDF.</div>
<div class="tag">New scan</div>
<svg width="640" height="630" viewBox="0 0 640 630">
<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity=".5"/></filter></defs>
<!-- photographed page: skewed, dim -->
<g filter="url(#sh)">
 <polygon points="30,170 250,130 285,430 10,470" fill="#cfcbc2"/>
 <g stroke="#8a8f94" stroke-width="5" stroke-linecap="round">
  <line x1="56" y1="212" x2="236" y2="182"/><line x1="60" y1="252" x2="242" y2="222"/><line x1="64" y1="292" x2="248" y2="262"/>
  <line x1="68" y1="332" x2="254" y2="302"/><line x1="72" y1="372" x2="190" y2="352"/>
 </g>
</g>
<g fill="#8ab4f8"><circle cx="30" cy="170" r="12"/><circle cx="250" cy="130" r="12"/><circle cx="285" cy="430" r="12"/><circle cx="10" cy="470" r="12"/></g>
<!-- arrow -->
<path d="M300 300 H350 M334 280 L356 300 L334 320" fill="none" stroke="#8ab4f8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<!-- straightened page -->
<g filter="url(#sh)">
 <rect x="390" y="110" width="200" height="290" rx="4" fill="#f5f4f1"/>
 <g stroke="#787e84" stroke-width="6" stroke-linecap="round">
  <line x1="418" y1="160" x2="562" y2="160"/><line x1="418" y1="196" x2="562" y2="196"/><line x1="418" y1="232" x2="562" y2="232"/>
  <line x1="418" y1="268" x2="562" y2="268"/><line x1="418" y1="304" x2="562" y2="304"/><line x1="418" y1="340" x2="520" y2="340"/>
 </g>
</g>
<g stroke="#8ab4f8" stroke-width="6" fill="none" stroke-linecap="square"><path d="M376 140 V96 H420"/><path d="M604 140 V96 H560"/><path d="M376 370 V414 H420"/><path d="M604 370 V414 H560"/></g>
<!-- PDF tag -->
<rect x="440" y="440" width="100" height="52" rx="10" fill="#1d5fb4"/><text x="490" y="476" font-family="system-ui,sans-serif" font-weight="800" font-size="28" fill="#fff" text-anchor="middle">PDF</text>
</svg></body></html>"""


def main():
    from PIL import Image
    with tempfile.TemporaryDirectory() as tmp:
        p, shot = Path(tmp) / "c.html", Path(tmp) / "c.png"
        p.write_text(PAGE, encoding="utf-8")
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                        "--force-device-scale-factor=1", "--window-size=1200,630",
                        f"--screenshot={shot}", p.as_uri()], check=True, capture_output=True, timeout=60)
        Image.open(shot).convert("RGB").crop((0, 0, 1200, 630)).save(OUT, "JPEG", quality=88, optimize=True)
    print(OUT)


if __name__ == "__main__":
    main()
