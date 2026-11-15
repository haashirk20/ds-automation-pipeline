"""Generates the README graphics in assets/readme/, one dark and one light file each."""
import sys
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

THEMES = {
    "dark": dict(bg="#0D1117", fg="#E6EDF3", mute="#8B949E", line="#30363D", card="#161B22",
                 acc="#FF7A59", paid="#E3B341", ok="#3FB950", warn="#8B949E"),
    "light": dict(bg="#FFFFFF", fg="#1F2328", mute="#59636E", line="#D1D9E0", card="#F6F8FA",
                  acc="#D4471F", paid="#9A6700", ok="#1A7F37", warn="#59636E"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"


class Svg:
    def __init__(self, w, h, title, t):
        self.w, self.h, self.t, self.parts = w, h, t, []
        self.title = title

    def add(self, s):
        self.parts.append(s)

    def text(self, x, y, s, size=13, color="fg", weight=400, anchor="start", mono=False, opacity=1):
        fam = MONO if mono else SANS
        self.add(f'<text x="{x}" y="{y}" font-family="{fam}" font-size="{size}" font-weight="{weight}" '
                 f'fill="{self.t[color]}" fill-opacity="{opacity}" text-anchor="{anchor}">{escape(s)}</text>')

    def rect(self, x, y, w, h, stroke="line", fill="card", r=6, sw=1, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        f = self.t[fill] if fill else "none"
        self.add(f'<rect x="{x}.5" y="{y}.5" width="{w}" height="{h}" rx="{r}" fill="{f}" '
                 f'stroke="{self.t[stroke]}" stroke-width="{sw}"{d}/>')

    def arrow(self, pts, color="mute", dash=None):
        d = " ".join(("M" if i == 0 else "L") + f"{x} {y}" for i, (x, y) in enumerate(pts))
        da = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<path d="{d}" fill="none" stroke="{self.t[color]}" stroke-width="1.5"{da} '
                 f'marker-end="url(#ah-{color})"/>')

    def tag(self, x, y, label, color):
        w = int(len(label) * 6.6) + 14
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="18" rx="9" fill="none" '
                 f'stroke="{self.t[color]}" stroke-width="1"/>')
        self.text(x + w / 2, y + 13, label, 10, color, 600, "middle", mono=True)
        return w

    def save(self, name, theme):
        markers = "".join(
            f'<marker id="ah-{c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{self.t[c]}"/></marker>'
            for c in ("mute", "acc", "ok", "paid"))
        body = "\n".join(self.parts)
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" '
               f'height="{self.h}" role="img"><title>{escape(self.title)}</title><defs>{markers}</defs>'
               f'<rect x=".5" y=".5" width="{self.w - 1}" height="{self.h - 1}" rx="8" fill="{self.t["bg"]}" '
               f'stroke="{self.t["line"]}"/>\n{body}\n</svg>\n')
        (OUT / f"{name}-{theme}.svg").write_text(svg)


def hero(t, theme):
    s = Svg(880, 380, "Shopify product to four short-video platforms: two 15-second vertical ads a day", t)
    s.text(40, 62, "SHOPIFY PRODUCT  →  DAILY VIDEO ADS", 12, "acc", 700, mono=True)
    s.text(40, 104, "One product in.", 34, "fg", 700)
    s.text(40, 144, "Two ads a day out.", 34, "fg", 700)
    lines = ["An unattended pipeline that writes, generates,",
             "checks and publishes 15-second vertical ads",
             "to Shorts, Reels and TikTok without a person."]
    for i, l in enumerate(lines):
        s.text(40, 182 + i * 21, l, 15, "mute")
    stats = [("2", "ads a day"), ("15 s", "1080×1920"), ("4", "platforms"), ("~$80", "a month")]
    for i, (big, small) in enumerate(stats):
        x = 40 + i * 92
        s.text(x, 290, big, 24, "fg", 700)
        s.text(x, 310, small, 12, "mute")
    s.add(f'<line x1="40" y1="334" x2="400" y2="334" stroke="{t["line"]}"/>')
    s.text(40, 356, "365 tests · TypeScript on Node 24 · Docker Compose", 12, "mute", mono=True)

    # product card
    s.rect(450, 120, 120, 140)
    s.rect(462, 132, 96, 64, fill="bg", r=4)
    s.add(f'<path d="M478 186 L496 162 L510 176 L520 168 L542 186 Z" fill="{t["mute"]}" fill-opacity=".45"/>')
    s.add(f'<circle cx="530" cy="148" r="6" fill="{t["mute"]}" fill-opacity=".45"/>')
    s.text(462, 216, "Shopify brief", 12, "fg", 600)
    s.text(462, 233, "facts + sources", 11, "mute")
    s.text(462, 248, "10 photos", 11, "mute")
    s.arrow([(574, 190), (604, 190)], "acc")

    # phone
    s.rect(610, 70, 124, 240, stroke="fg", fill="card", r=16, sw=1.5)
    s.rect(620, 84, 104, 212, fill="bg", r=8)
    s.add(f'<rect x="632" y="98" width="80" height="8" rx="4" fill="{t["fg"]}"/>')
    s.add(f'<rect x="644" y="111" width="56" height="8" rx="4" fill="{t["fg"]}"/>')
    s.add(f'<circle cx="672" cy="190" r="18" fill="none" stroke="{t["acc"]}" stroke-width="1.5"/>')
    s.add(f'<path d="M666 181 L682 190 L666 199 Z" fill="{t["acc"]}"/>')
    s.add(f'<rect x="632" y="272" width="80" height="4" rx="2" fill="{t["line"]}"/>')
    s.add(f'<rect x="632" y="272" width="34" height="4" rx="2" fill="{t["acc"]}"/>')
    s.text(672, 334, "AI clip + caption", 11, "mute", anchor="middle")

    plats = [("YouTube Shorts", "ok"), ("TikTok", "ok"), ("Instagram Reels", "warn"), ("Facebook Reels", "warn")]
    for i, (p, c) in enumerate(plats):
        y = 108 + i * 46
        s.arrow([(738, 190), (756, y + 14)], "mute")
        s.rect(760, y, 92, 30, r=15)
        s.add(f'<circle cx="774" cy="{y + 15}" r="4" fill="{t[c]}"/>')
        s.text(784, y + 19, p.split()[0], 12, "fg", 600)
    s.add(f'<circle cx="764" cy="306" r="4" fill="{t["ok"]}"/>')
    s.text(772, 310, "live-tested", 10, "mute")
    s.add(f'<circle cx="764" cy="322" r="4" fill="{t["warn"]}"/>')
    s.text(772, 326, "not connected yet", 10, "mute")
    s.save("hero", theme)


def pipeline(t, theme):
    s = Svg(880, 460, "One slot: ingest, concept, claim judge, paid clip, frame check, render and QA, copy, publish", t)
    s.text(40, 44, "ONE SLOT, START TO FINISH", 12, "acc", 700, mono=True)
    s.text(40, 66, "A tick runs every 60 s. Each step writes to SQLite, fenced by the slot's claim time.", 13, "mute")
    steps = [
        ("1", "Ingest", "Shopify Admin API", "brief: facts + sources", "CODE"),
        ("2", "Concept", "setting, caption, line,", "3 to 5 shots as JSON", "MODEL"),
        ("3", "Claim judge", "locked prompt: every", "claim is in the brief", "MODEL"),
        ("4", "Clip", "quote, budget, ledger", "row, one Higgsfield job", "PAID"),
        ("5", "Frame check", "8 frames vs reference", "photos + product note", "MODEL"),
        ("6", "Render + QA", "Remotion caption, music,", "-14 LUFS, 10 checks", "CODE"),
        ("7", "Copy", "titles and captions,", "then a locked judge", "MODEL"),
        ("8", "Publish", "Zernio bridge, saved", "handle, idempotency key", "CODE"),
    ]
    colors = {"CODE": "mute", "MODEL": "acc", "PAID": "paid"}
    bw, bh, gap = 182, 118, 20
    for i, (n, name, a, b, kind) in enumerate(steps):
        row, col = divmod(i, 4)
        x = 40 + col * (bw + gap)
        y = 96 + row * (bh + 54)
        stroke = colors[kind] if kind != "CODE" else "line"
        s.rect(x, y, bw, bh, stroke=stroke, sw=1.5 if kind != "CODE" else 1)
        s.text(x + 16, y + 30, n, 13, "mute", 700, mono=True)
        s.text(x + 36, y + 30, name, 16, "fg", 700)
        s.text(x + 16, y + 62, a, 12, "mute")
        s.text(x + 16, y + 80, b, 12, "mute")
        s.tag(x + 16, y + 90, kind, colors[kind])
        if col < 3:
            s.arrow([(x + bw + 2, y + bh / 2), (x + bw + gap - 2, y + bh / 2)])
    # row wrap
    s.arrow([(40 + 3 * (bw + gap) + bw / 2, 96 + bh + 2), (40 + 3 * (bw + gap) + bw / 2, 96 + bh + 27),
             (40 + bw / 2, 96 + bh + 27), (40 + bw / 2, 96 + bh + 52)])
    y = 432
    for i, (k, label) in enumerate([("MODEL", "one structured model call"), ("PAID", "checks price + budget first"),
                                    ("CODE", "deterministic code")]):
        x = 40 + i * 270
        w = s.tag(x, y - 13, k, colors[k])
        s.text(x + w + 10, y + 1, label, 12, "mute")
    s.save("pipeline", theme)


def services(t, theme):
    s = Svg(880, 420, "Three compose services share one SQLite database; the pipeline calls Shopify, Anthropic, Higgsfield and the Zernio bridge", t)
    s.text(40, 44, "THREE CONTAINERS, ONE DATABASE", 12, "acc", 700, mono=True)

    def box(x, y, w, h, title, sub, stroke="line", sw=1):
        s.rect(x, y, w, h, stroke=stroke, sw=sw)
        s.text(x + 14, y + 26, title, 14, "fg", 700)
        for i, l in enumerate(sub):
            s.text(x + 14, y + 46 + i * 17, l, 12, "mute")

    box(40, 90, 140, 70, "Owner", ["browser over SSH", "tunnel or Tailscale"])
    s.arrow([(182, 125), (218, 125)])
    box(220, 80, 190, 90, "admin", ["127.0.0.1:8080 only", "no API keys", "settings, prompts, posts"])
    s.arrow([(315, 172), (315, 206)])
    s.arrow([(315, 206), (315, 172)])
    s.rect(220, 208, 190, 70, stroke="acc", sw=1.5)
    s.text(234, 234, "SQLite (WAL)", 14, "fg", 700)
    s.text(234, 254, "data/pipeline.db", 12, "mute", mono=True)
    s.arrow([(412, 243), (468, 243)])
    s.arrow([(468, 243), (412, 243)])
    box(470, 198, 170, 90, "pipeline", ["tick every 60 s", "one producer child", "per slot"])
    s.arrow([(315, 280), (315, 316)])
    box(220, 318, 190, 70, "backup", ["restic, nightly", "→ Cloudflare R2"])

    ext = [("Shopify", "product + photos"), ("Anthropic API", "5 structured calls"),
           ("Higgsfield MCP", "AI video clip"), ("Zernio bridge", "→ 4 platforms")]
    for i, (n, d) in enumerate(ext):
        y = 80 + i * 74
        s.rect(690, y, 150, 58, dash="4 3")
        s.text(704, y + 24, n, 13, "fg", 700)
        s.text(704, y + 42, d, 11, "mute")
        s.arrow([(642, 243), (688, y + 29)])
    s.text(470, 318, "alerts → Discord or Telegram", 12, "mute")
    s.text(470, 338, "heartbeat → healthchecks.io", 12, "mute")
    s.text(40, 398, "dashed: hosted services", 11, "mute")
    s.save("services", theme)


def publish(t, theme):
    s = Svg(880, 400, "Never double-post: the publisher reads its stored handle before every request", t)
    s.text(40, 44, "NEVER DOUBLE-POST", 12, "acc", 700, mono=True)
    s.text(40, 66, "Every publish attempt starts by reading what it stored last time.", 13, "mute")
    s.rect(40, 168, 150, 64, stroke="acc", sw=1.5)
    s.text(115, 196, "Stored handle?", 14, "fg", 700, "middle")
    s.text(115, 215, "read first, every call", 11, "mute", anchor="middle")

    rows = [
        (100, "none", ["find account, upload video", "saveHandle({ mediaUrl, at })", "POST /posts + Idempotency-Key"],
         "store postId", "ok"),
        (200, "no postId", ["create may have been sent", "under 23 h: resend, same key", "older: key may be forgotten"],
         "needs_attention", "paid"),
        (300, "postId", ["GET /posts/{id} only", "poll every 10 s, up to 9 times", "never a second create"],
         "published | failed", "ok"),
    ]
    for y, label, lines, end, c in rows:
        s.arrow([(192, 200), (232, 200), (232, y + 34), (318, y + 34)])
        s.text(244, y + 26, label, 11, "mute", 600, mono=True)
        s.rect(320, y, 284, 76)
        for i, l in enumerate(lines):
            mono = "(" in l or "/" in l
            s.text(336, y + 24 + i * 19, l, 12, "fg" if i == 0 else "mute", mono=mono)
        s.arrow([(606, y + 38), (650, y + 38)], c)
        s.rect(652, y + 18, 188, 40, stroke=c, sw=1.5)
        s.text(746, y + 43, end, 12, "fg", 700, "middle", mono=True)
    s.text(40, 300, "A missed post is", 13, "fg", 700)
    s.text(40, 318, "acceptable.", 13, "fg", 700)
    s.text(40, 340, "A double post is not.", 13, "acc", 700)
    s.save("publish", theme)


for theme, t in THEMES.items():
    for f in (hero, pipeline, services, publish):
        f(t, theme)
print("ok", sorted(p.name for p in OUT.iterdir()))
