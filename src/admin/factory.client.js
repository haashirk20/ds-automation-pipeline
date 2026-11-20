// The Factory page's only script, served at /factory.js. It draws the pipeline as a top-down pixel-art
// factory on one canvas. Every sprite is drawn here in code; there are no image files. It reads
// /factory.json every few seconds and moves each crate (video) along the belt to its station. It never
// writes, builds page nodes with createElement and textContent only, and only fetches this origin.
'use strict';
(() => {
  const cv = document.getElementById('factory');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  // The floor always moves unless the viewer pauses it with the button (remembered in this browser only).
  let reduce = false;
  try { reduce = localStorage.getItem('factory-still') === '1'; } catch { /* storage blocked: animate */ }
  const demo = cv.dataset.demo === '1';

  const STAGES = ['dock', 'design', 'foundry', 'inspect', 'paint', 'label', 'gate', 'shipping'];
  const NAMES = { dock: 'Loading dock', design: 'Concept studio', foundry: 'Clip foundry', inspect: 'Inspection', paint: 'Caption shop', label: 'Label press', gate: 'Approval gate', shipping: 'Shipping docks', shipped: 'Shipped', scrap: 'Thrown away' };
  const DOING = {
    dock: 'Planned. The factory picks it up soon; videos you made by hand go first.',
    design: 'Reads the product page, writes the idea for the video and checks the ad only says what the product page says.',
    foundry: 'Makes the 15 second video clip (a paid step), or reuses one you already have.',
    inspect: 'Looks at the clip and checks it matches your product photos and your note.',
    paint: 'Adds the captions and music, evens out the sound and runs the quality check.',
    label: 'Writes the titles, captions and hashtags for each platform, then checks them.',
    gate: 'A video you made by hand waits here until you press Post it or Discard on the Videos page.',
    shipping: 'Each platform gets the video at its planned time.',
    shipped: 'Posted everywhere.',
    scrap: 'The video failed or was discarded. Nothing was posted.',
  };
  const PL = ['youtube', 'facebook', 'instagram', 'tiktok'];
  const PL_NAME = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
  const PUB_WORD = { pending: 'Waiting', uploading: 'Posting', published: 'Posted', skipped: 'Skipped', needs_attention: 'Needs you' };
  // The shop's local time, same format as the server's fmtLocal: "Fri 20 Nov, 12:15".
  let tz;
  const fmtLocal = (iso) => {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    let p;
    try { p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); } catch { return ''; }
    const g = (t) => (p.find((x) => x.type === t) || { value: '' }).value;
    return g('weekday') + ' ' + g('day') + ' ' + g('month').replace('.', '') + ', ' + g('hour') + ':' + g('minute');
  };
  const slotName = (s) => s.name || fmtLocal(s.when) + ', ' + (s.kind === 'manual' ? 'Made now' : 'Post ' + s.idx);
  const PL_SHORT = { youtube: 'YT', facebook: 'FB', instagram: 'IG', tiktok: 'TT' };

  // ---------- palette ----------
  const C = {
    ink: '#1b1c24', grass: '#5c9c3e', grassD: '#4c8a34', grassL: '#72b24c', grassLL: '#8cc65a',
    dirt: '#c8a36a', dirtD: '#a9844f', dirtL: '#dcbd86',
    road: '#4d5058', roadL: '#646872', apron: '#9a9c98', apronD: '#868883',
    st: '#8e98a6', stL: '#c3cad3', stD: '#5d6673', stDD: '#3e444e',
    belt: '#3b3f48', beltL: '#5f6571', haz: '#e7b52c', hazD: '#2a2b30',
    red: '#c0393b', redD: '#86252a', redL: '#e2615a',
    blue: '#2f6fd6', blueD: '#1f4a94', blueL: '#5d97ee',
    wood: '#a8703f', woodD: '#7a4c28', woodL: '#c98e55',
    crate: '#d29a5a', crateL: '#e8b97a', crateD: '#9c6a36', tape: '#efd9a6',
    fire: '#ff9a2e', fireL: '#ffe17a', fireD: '#d9481f',
    green: '#3fd47a', greenD: '#1f6a3c', amber: '#f5a524', pink: '#ff6fae', teal: '#3fd4c9',
    water: '#3a8fd6', waterL: '#8ccaf5', waterD: '#2a6aa6',
    leaf: '#2f7a3a', leafL: '#46a04c', leafD: '#1f5a2c', trunk: '#6b4426',
    skin: '#f0c39a', glass: '#7cc4f0', white: '#f4f4f4',
  };
  const TRUCK = {
    youtube: ['#d6342c', '#f0645a', '#9a2019'],
    facebook: ['#1f6fe0', '#5a98f0', '#164f9e'],
    instagram: ['#c2378a', '#e06aae', '#86255e'],
    tiktok: ['#24262c', '#454852', '#111216'],
  };

  // ---------- pixel helpers (integer coordinates, no smoothing) ----------
  let g = ctx;
  const R = (x, y, w, h, c) => {
    g.fillStyle = c;
    g.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const P = (x, y, c) => R(x, y, 1, 1, c);
  function disc(cx, cy, r, c) {
    g.fillStyle = c;
    cx = Math.round(cx);
    cy = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.round(Math.sqrt(r * r - dy * dy));
      g.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
    }
  }
  function oval(cx, cy, rx, ry, c) {
    g.fillStyle = c;
    for (let dy = -ry; dy <= ry; dy++) {
      const w = Math.round(rx * Math.sqrt(1 - (dy * dy) / (ry * ry)));
      g.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
    }
  }
  // Bresenham line; col is a colour or a function of the step index.
  function line(x0, y0, x1, y1, col, w) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    w = w || 1;
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let i = 0; ; i++) {
      g.fillStyle = typeof col === 'function' ? col(i) : col;
      g.fillRect(x0, y0, w, w);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  const shade = (x, y, w, h, a) => {
    g.fillStyle = 'rgba(16,28,8,' + (a || 0.28) + ')';
    g.fillRect(Math.round(x), Math.round(y), w, h);
  };
  // A building seen from above at a slight angle: roof (top face) and a front wall of height f.
  function block(x, y, w, h, f, top, topL, topD, wall, wallD) {
    shade(x + 3, y + 3, w, h);
    R(x - 1, y - 1, w + 2, h + 2, C.ink);
    R(x, y, w, h - f, top);
    R(x, y, w, 1, topL);
    R(x, y + h - f - 1, w, 1, topD);
    R(x, y + h - f, w, f, wall);
    R(x, y + h - 1, w, 1, wallD);
  }
  function cylinder(cx, top, bot, r, mid, light, dark) {
    shade(cx - r + 3, top + 3, r * 2 + 1, bot - top);
    R(cx - r - 1, top, r * 2 + 3, bot - top + 2, C.ink);
    for (let i = -r; i <= r; i++) {
      const k = i / r;
      R(cx + i, top, 1, bot - top + 1, k < -0.6 ? dark : k < -0.15 ? mid : k < 0.15 ? light : k < 0.6 ? mid : dark);
    }
    for (let yy = top + 10; yy < bot - 2; yy += 11) R(cx - r, yy, r * 2 + 1, 1, dark);
    disc(cx, top, r + 1, C.ink);
    disc(cx, top, r, mid);
    disc(cx - 2, top - 2, Math.max(2, r - 4), light);
    disc(cx, top, 2, dark);
  }
  function gear(cx, cy, a, c) {
    disc(cx, cy, 3, C.ink);
    for (let k = 0; k < 4; k++) {
      const an = a + (k * Math.PI) / 2;
      R(Math.round(cx + Math.cos(an) * 3.6) - 1, Math.round(cy + Math.sin(an) * 3.6) - 1, 3, 3, C.ink);
    }
    disc(cx, cy, 2, c);
    for (let k = 0; k < 4; k++) {
      const an = a + (k * Math.PI) / 2;
      P(Math.round(cx + Math.cos(an) * 3.6), Math.round(cy + Math.sin(an) * 3.6), c);
    }
    P(cx, cy, C.ink);
  }

  // ---------- 3x5 pixel font ----------
  const FONT = {
    A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
    G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
    M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5],
    S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
    Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], 0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [6, 1, 2, 4, 7], 3: [6, 1, 2, 1, 6],
    4: [5, 5, 7, 1, 1], 5: [7, 4, 6, 1, 6], 6: [3, 4, 6, 5, 2], 7: [7, 1, 2, 2, 2], 8: [2, 5, 2, 5, 2], 9: [2, 5, 3, 1, 6],
    '#': [5, 7, 5, 7, 5], '.': [0, 0, 0, 0, 2], '-': [0, 0, 7, 0, 0], ':': [0, 2, 0, 2, 0], ' ': [0, 0, 0, 0, 0],
    '?': [6, 1, 2, 0, 2], '/': [1, 1, 2, 4, 4], '+': [0, 2, 7, 2, 0], ',': [0, 0, 0, 2, 4], "'": [2, 2, 0, 0, 0],
  };
  const tw = (s) => String(s).length * 4 - 1;
  function text(s, x, y, c) {
    s = String(s).toUpperCase();
    g.fillStyle = c;
    x = Math.round(x);
    y = Math.round(y);
    for (const ch of s) {
      const gl = FONT[ch] || FONT['?'];
      for (let r = 0; r < 5; r++) {
        if (gl[r] & 4) g.fillRect(x, y + r, 1, 1);
        if (gl[r] & 2) g.fillRect(x + 1, y + r, 1, 1);
        if (gl[r] & 1) g.fillRect(x + 2, y + r, 1, 1);
      }
      x += 4;
    }
  }
  function tag(s, x, y, border) {
    const w = tw(s) + 4;
    x = Math.max(1, Math.min(W - w - 2, Math.round(x)));
    y = Math.max(1, Math.min(H - 11, Math.round(y)));
    R(x - 1, y - 1, w + 2, 11, border || C.amber);
    R(x, y, w, 9, C.ink);
    text(s, x + 2, y + 2, C.white);
  }

  // ---------- sprites: pixel maps with an automatic outline ----------
  function sprite(w, h, paint) {
    const px = Array.from({ length: h }, () => new Array(w).fill(null));
    paint((x, y, c) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < w && y < h) px[y][x] = c;
    });
    const s = document.createElement('canvas');
    s.width = w + 2;
    s.height = h + 2;
    const sg = s.getContext('2d');
    for (let y = -1; y <= h; y++)
      for (let x = -1; x <= w; x++) {
        const on = (a, b) => a >= 0 && b >= 0 && a < w && b < h && px[b][a];
        if (on(x, y)) {
          sg.fillStyle = px[y][x];
          sg.fillRect(x + 1, y + 1, 1, 1);
        } else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) {
          sg.fillStyle = C.ink;
          sg.fillRect(x + 1, y + 1, 1, 1);
        }
      }
    return s;
  }
  const fromMap = (rows, pal) => sprite(rows[0].length, rows.length, (put) => rows.forEach((r, y) => [...r].forEach((ch, x) => { if (pal[ch]) put(x, y, pal[ch]); })));

  function pine(dark) {
    const lf = dark ? ['#3a8a42', '#256b33', '#174a24'] : [C.leafL, C.leaf, C.leafD];
    return sprite(15, 22, (put) => {
      for (let t = 0; t < 3; t++) {
        const y0 = t * 5;
        for (let r = 0; r < 8; r++) {
          const half = Math.min(7, 1 + Math.floor(r * 0.75) + t);
          for (let dx = -half; dx <= half; dx++) {
            let c = dx < -half / 3 ? lf[0] : dx > half / 3 ? lf[2] : lf[1];
            if (r === 7 && (dx + t) % 2 === 0) c = lf[2];
            put(7 + dx, y0 + r, c);
          }
        }
      }
      for (let y = 18; y < 22; y++) { put(6, y, C.trunk); put(7, y, '#8a5a34'); put(8, y, C.trunk); }
    });
  }
  const TREES = [pine(false), pine(true)];
  const BUSH = sprite(9, 6, (put) => {
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 9; x++) {
        const dx = (x - 4) / 4.5, dy = (y - 3) / 3;
        if (dx * dx + dy * dy <= 1) put(x, y, y < 2 ? C.leafL : y > 3 ? C.leafD : C.leaf);
      }
    put(2, 2, '#e8504a'); put(6, 3, '#e8504a');
  });
  const ROCK = fromMap(['.aab.', 'aabbc', 'bbccc'], { a: '#b7bcc2', b: '#8e949c', c: '#6b7078' });

  const WORKER = [
    ['..yyyy..', '.yYYYYy.', '.yyyyyy.', '..ssss..', '..esse..', '..rssr..', '.bbbbbb.', 'sbOOOObs', '..OOOO..', '..OOOO..', '..O..O..', '..d..d..'],
    ['..yyyy..', '.yYYYYy.', '.yyyyyy.', '..ssss..', '..esse..', '..rssr..', '.bbbbbb.', 'sbOOOObs', '..OOOO..', '..OOOO..', '..O.O...', '..dd.d..'],
  ];
  const CREW = [
    { y: '#e8b923', Y: '#ffe07a', b: '#2f6fd6', r: '#8a4a22' },
    { y: '#f08a24', Y: '#ffc070', b: '#c0393b', r: '#f0c39a' },
    { y: '#f4f4f4', Y: '#ffffff', b: '#2e8b57', r: '#5a3a1a' },
    { y: '#e8b923', Y: '#ffe07a', b: '#8a5ac8', r: '#f0c39a' },
  ].map((p) => {
    const pal = { y: p.y, Y: p.Y, s: C.skin, e: C.ink, r: p.r, b: p.b, O: '#34508a', d: '#3a2a1c' };
    const fr = WORKER.map((m) => fromMap(m, pal));
    const fl = WORKER.map((m) => fromMap(m.map((r) => [...r].reverse().join('')), pal));
    return [fr, fl];
  });
  const DUCK = [fromMap(['.ww..', 'wwwwo', '.www.'], { w: '#f4f4f4', o: '#f0a020' }), fromMap(['..ww.', 'owwww', '.www.'], { w: '#f4f4f4', o: '#f0a020' })];

  // ---------- layout ----------
  // The belt: left to right along row A, down the right side, right to left along row B, down into shipping.
  const PATH = [[8, 92], [500, 92], [500, 196], [72, 196], [72, 248]];
  const SEGS = [];
  let TOTAL = 0;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [x0, y0] = PATH[i], [x1, y1] = PATH[i + 1];
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    SEGS.push({ x0, y0, x1, y1, len, d0: TOTAL, dx: Math.sign(x1 - x0), dy: Math.sign(y1 - y0) });
    TOTAL += len;
  }
  function at(d) {
    d = Math.max(0, Math.min(TOTAL, d));
    for (const s of SEGS) if (d <= s.d0 + s.len) return { x: s.x0 + s.dx * (d - s.d0), y: s.y0 + s.dy * (d - s.d0), h: s.dy === 0 };
    const s = SEGS[SEGS.length - 1];
    return { x: s.x1, y: s.y1, h: false };
  }
  // Where the first crate at each station stops; later crates queue behind it.
  const ANCHOR = { dock: 50, design: 138, foundry: 248, inspect: 338, paint: 668, label: 768, gate: 864, shipping: 1050 };
  const QGAP = 13;
  const QMAX = 4;
  // Clickable area of each station [x, y, w, h], and the trucks' bays.
  const AREA = {
    dock: [4, 36, 62, 48], design: [122, 42, 48, 42], foundry: [208, 16, 72, 68], inspect: [322, 48, 48, 58],
    paint: [404, 146, 48, 42], label: [304, 142, 48, 46], gate: [200, 160, 56, 46], shipping: [40, 234, 230, 34],
  };
  const BAYS = { youtube: 88, facebook: 136, instagram: 184, tiktok: 232 };
  const SIGN = { dock: [24, 101], design: [128, 101], foundry: [230, 101], inspect: [318, 101], paint: [446, 205], label: [346, 205], gate: [244, 205], shipping: [82, 210] };
  const BIN = { x: 362, y: 106 };
  const binSpot = (k) => ({ x: BIN.x + 7 + (k % 3) * 8, y: BIN.y + 9 + Math.floor(k / 3) * 5 });
  const MAX_SCRAP = 6;

  // ---------- the ground: drawn once ----------
  function mulberry(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function drawCrate(x, y, o) {
    o = o || {};
    const X = Math.round(x) - 5, Y = Math.round(y) - 7;
    const grey = o.grey;
    const base = grey ? '#8d8a84' : C.crate, light = grey ? '#a9a6a0' : C.crateL, dark = grey ? '#66635e' : C.crateD;
    shade(X + 1, Y + 9, 10, 2, 0.3);
    R(X, Y, 10, 10, C.ink);
    R(X + 1, Y + 1, 8, 8, base);
    R(X + 1, Y + 1, 8, 1, light);
    R(X + 1, Y + 6, 8, 3, dark);
    R(X + 1, Y + 7, 8, 1, base);
    R(X + 4, Y + 1, 2, 5, grey ? '#b8b4ac' : o.manual ? C.blueL : C.tape);
    const lvl = o.lvl || 0;
    if (lvl >= 2) { P(X + 1, Y + 2, C.blueL); P(X + 2, Y + 2, C.blue); P(X + 1, Y + 3, C.blue); }
    if (lvl >= 3) { P(X + 7, Y + 2, C.ink); P(X + 8, Y + 2, C.amber); P(X + 7, Y + 3, C.amber); P(X + 8, Y + 3, C.ink); }
    if (lvl >= 4) { P(X + 2, Y + 4, C.green); P(X + 1, Y + 4, C.greenD); }
    if (lvl >= 5) { R(X + 1, Y + 1, 3, 1, C.pink); R(X + 6, Y + 1, 3, 1, C.teal); }
    if (lvl >= 6) { R(X + 9, Y + 5, 2, 3, C.ink); P(X + 10, Y + 6, '#e8702a'); }
  }
  function buildGround() {
    const s = document.createElement('canvas');
    s.width = W;
    s.height = H;
    g = s.getContext('2d');
    const rnd = mulberry(20261117);
    R(0, 0, W, H, C.grass);
    for (let i = 0; i < 1500; i++) {
      const k = rnd();
      R(rnd() * W, rnd() * H, 1, k < 0.5 ? 2 : 1, k < 0.45 ? C.grassD : k < 0.85 ? C.grassL : C.grassLL);
    }
    for (let i = 0; i < 90; i++) {
      const x = Math.round(rnd() * W), y = Math.round(rnd() * H);
      R(x, y, 1, 2, C.grassD); R(x + 2, y, 1, 2, C.grassD); R(x + 1, y + 1, 1, 2, C.grassD);
    }
    // dirt patches (border first, then fill, so blobs merge)
    const blobs = [[34, 114, 18], [52, 128, 12], [377, 118, 17], [396, 126, 10], [318, 226, 13], [300, 20, 10], [88, 172, 14], [150, 178, 12], [470, 228, 9]];
    for (const [x, y, r] of blobs) disc(x, y, r + 1, C.dirtD);
    for (const [x, y, r] of blobs) disc(x, y, r, C.dirt);
    for (let i = 0; i < 70; i++) {
      const [x, y, r] = blobs[i % blobs.length];
      const a = rnd() * Math.PI * 2, d = rnd() * (r - 2);
      P(x + Math.cos(a) * d, y + Math.sin(a) * d, rnd() < 0.5 ? C.dirtD : C.dirtL);
    }
    // pond
    oval(452, 266, 50, 24, C.dirtL);
    oval(452, 266, 46, 21, C.waterD);
    oval(452, 268, 44, 18, C.water);
    for (const [x, y] of [[424, 270], [478, 262], [446, 280]]) { oval(x, y, 4, 2, '#3f9a4a'); P(x - 1, y - 1, '#7ac868'); }
    // apron under the trucks, and the road
    R(36, 266, 238, 34, C.apron);
    for (let x = 36; x < 274; x += 12) R(x, 266, 1, 34, C.apronD);
    R(0, 300, W, 20, C.road);
    R(0, 300, W, 1, C.roadL);
    for (let x = 4; x < W; x += 14) R(x, 310, 7, 1, C.haz);
    // belt bed: edges for all segments first, then the running surface
    for (const s of SEGS) {
      const x = Math.min(s.x0, s.x1) - 7, y = Math.min(s.y0, s.y1) - 7;
      const w = Math.abs(s.x1 - s.x0) + 14, h = Math.abs(s.y1 - s.y0) + 14;
      R(x, y, w, h, C.ink);
      if (s.dy === 0) for (let i = 0; i < w - 2; i++) { const c = Math.floor(i / 3) % 2 ? C.hazD : C.haz; R(x + 1 + i, y + 1, 1, 2, c); R(x + 1 + i, y + h - 3, 1, 2, c); }
      else for (let i = 0; i < h - 2; i++) { const c = Math.floor(i / 3) % 2 ? C.hazD : C.haz; R(x + 1, y + 1 + i, 2, 1, c); R(x + w - 3, y + 1 + i, 2, 1, c); }
    }
    for (const s of SEGS) {
      const x = Math.min(s.x0, s.x1) - 4, y = Math.min(s.y0, s.y1) - 4;
      R(x, y, Math.abs(s.x1 - s.x0) + 8, Math.abs(s.y1 - s.y0) + 8, C.belt);
    }
    // rollers at the start of the belt
    R(2, 85, 3, 14, C.stD);
    // barrels and a pallet of empty crates by the gate
    for (const [x, y, c, cl] of [[96, 168, C.red, C.redL], [106, 172, C.blue, C.blueL], [94, 180, C.red, C.redL], [116, 166, '#e7b52c', '#ffe07a']]) {
      disc(x, y, 5, C.ink); disc(x, y, 4, c); disc(x - 1, y - 1, 2, cl); R(x - 4, y, 9, 1, C.ink);
    }
    R(134, 168, 32, 18, C.woodD);
    for (let i = 0; i < 4; i++) R(134, 169 + i * 4, 32, 2, C.wood);
    drawCrate(141, 180); drawCrate(152, 180); drawCrate(146, 172);
    // pallets by the dock
    R(8, 108, 26, 16, C.woodD);
    for (let i = 0; i < 4; i++) R(8, 109 + i * 4, 26, 2, C.wood);
    drawCrate(15, 120); drawCrate(26, 120); drawCrate(20, 112);
    // rocks, bushes, flowers
    for (const [x, y] of [[488, 52], [180, 122], [30, 276], [286, 210], [510, 230], [60, 152], [396, 228]]) g.drawImage(ROCK, x, y);
    for (const [x, y] of [[112, 136], [278, 134], [18, 200], [372, 286], [258, 208], [184, 60], [474, 300 - 12]]) g.drawImage(BUSH, x, y);
    for (let i = 0; i < 60; i++) {
      const x = Math.round(rnd() * W), y = Math.round(rnd() * 296);
      P(x, y, ['#ffe25a', '#ffffff', '#ff8fb8', '#b8a0ff'][i % 4]);
    }
    // trees, back to front
    const trees = [[20, 30], [104, 32], [182, 40], [290, 82], [470, 82], [524, 40], [530, 100], [516, 150], [528, 214], [40, 142], [462, 138], [18, 262], [20, 298], [290, 270], [372, 302], [520, 282], [538, 250], [160, 30], [384, 34], [8, 186], [54, 214]];
    trees.sort((a, b) => a[1] - b[1]);
    trees.forEach(([x, y], i) => {
      oval(x, y, 6, 2, 'rgba(16,28,8,.3)');
      g.drawImage(TREES[i % 2], x - 8, y - 23);
    });
    // power line across the top
    const poles = [72, 196, 300, 452];
    for (let i = 0; i < poles.length - 1; i++)
      for (const off of [-5, 6]) {
        const x0 = poles[i] + off, x1 = poles[i + 1] + off;
        for (let x = x0; x <= x1; x++) P(x, 6 + Math.round(3 * Math.sin((Math.PI * (x - x0)) / (x1 - x0))), '#2a2b30');
      }
    for (const x of poles) {
      shade(x + 2, 4, 2, 24);
      R(x - 1, 2, 4, 26, C.ink); R(x, 3, 2, 24, C.trunk);
      R(x - 6, 4, 14, 4, C.ink); R(x - 5, 5, 12, 2, C.woodD);
      P(x - 5, 4, C.stL); P(x + 6, 4, C.stL);
    }
    g = ctx;
    return s;
  }
  const GROUND = buildGround();

  // ---------- state ----------
  const crates = new Map(); // slot id -> { id, slot, d, target, alpha, leaving, removeAt, fly, bin, lvl, pos }
  let counts = {};
  let last = null;
  let prevPublished = null;
  let first = true;
  let T = 0;
  let dt = 0;
  let gateA = 0;
  let hover = null;
  let selected = null; // { type: 'crate' | 'station' | 'truck', id }
  const flashAt = {};
  const parts = [];
  const emit = {};
  const trucks = Object.fromEntries(PL.map((p) => [p, { state: 'parked', t: 0, off: 0, loading: false }]));
  const blink = (period, duty, ph) => ((T + (ph || 0)) % period) / period < (duty === undefined ? 0.5 : duty);
  const busy = (k) => (counts[k] || 0) > 0 || (k === 'shipping' && PL.some((p) => trucks[p].loading));

  const ZONES = [[92, 112, 340, 134], [92, 112, 340, 134], [296, 232, 392, 292], [8, 104, 60, 132]];
  const workers = ZONES.map((z, i) => ({ z, x: (z[0] + z[2]) / 2, y: (z[1] + z[3]) / 2, tx: z[0], ty: z[1], wait: i, face: 0, crew: CREW[i % CREW.length] }));

  function spawn(kind, x, y, o) {
    if (parts.length > 260) return;
    parts.push(Object.assign({ kind, x, y, vx: 0, vy: 0, life: 1, max: 1 }, o));
  }
  function every(key, rate, fn) {
    emit[key] = (emit[key] || 0) + dt * rate;
    while (emit[key] >= 1) {
      emit[key]--;
      fn();
    }
  }

  // ---------- machines ----------
  function mDock() {
    const b = busy('dock');
    const x = 4, y = 36, w = 62, h = 46, f = 12;
    block(x, y, w, h, f, C.red, C.redL, C.redD, '#8b8f98', '#5d6673');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, C.redD);
    R(x, y + 15, w, 2, C.redL);
    for (const sx of [x + 6, x + 44]) { R(sx, y + 5, 12, 6, C.ink); R(sx + 1, y + 6, 10, 4, C.glass); P(sx + 2, y + 6, C.white); }
    const dx = x + 30, dy = y + h - f + 1, dw = 20, dh = f - 2;
    R(dx - 1, dy - 1, dw + 2, dh + 1, C.ink);
    R(dx, dy, dw, dh, '#141519');
    const open = b && !reduce ? (Math.sin(T * 1.7) * 0.5 + 0.5) * 0.75 : 0;
    const sh = Math.round(dh * (1 - open));
    for (let i = 0; i < sh; i++) R(dx, dy + i, dw, 1, i % 2 ? C.stD : C.stL);
    text('DOCK', x + 5, dy + 2, C.white);
    disc(x + w - 6, y + 5, 2, C.ink);
    disc(x + w - 6, y + 5, 1, b ? (blink(0.6) ? C.amber : '#7a5a1a') : '#7a5a1a');
  }
  function mDesign() {
    const b = busy('design');
    const x = 122, y = 42, w = 48, h = 40, f = 12;
    block(x, y, w, h, f, '#4b6b9a', '#6f8fbf', '#344e75', '#9aa5b5', '#6b7584');
    R(x + 4, y + 4, 13, 9, C.ink); R(x + 5, y + 5, 11, 7, C.stL);
    gear(x + 10, y + 8, T * (b ? 6 : 1.2), C.stD);
    R(x + 39, y + 2, 1, 12, C.stDD);
    P(x + 39, y + 1, blink(1.2, 0.3) ? '#ff4040' : '#6a1c1c');
    const lit = b ? (blink(0.25, 0.8) ? '#ffe27a' : '#ffd040') : '#8a7a3a';
    disc(x + 27, y + 12, 5, C.ink); disc(x + 27, y + 12, 4, lit);
    if (b) { P(x + 25, y + 10, C.white); R(x + 26, y + 18, 3, 1, C.stDD); }
    const sx = x + 6, sy = y + h - f + 2, sw = 24, sh = 8;
    R(sx - 1, sy - 1, sw + 2, sh + 2, C.ink);
    R(sx, sy, sw, sh, '#0b1a2e');
    if (b) {
      for (let i = 0; i < 4; i++) {
        const row = Math.floor(T * 5) + i;
        R(sx + 1, sy + 1 + i * 2, [14, 9, 20, 6, 12, 18, 8][row % 7], 1, [C.teal, C.green, C.amber][row % 3]);
      }
    } else if (blink(1)) R(sx + 1, sy + 1, 2, 1, C.green);
    R(x + 34, y + h - f + 1, 9, f - 1, C.ink);
    R(x + 35, y + h - f + 2, 7, f - 3, '#5d6673');
    P(x + 40, y + h - 6, C.amber);
  }
  function oDesign() {
    const b = busy('design');
    const ax = 146;
    const down = b && !reduce ? Math.max(0, Math.sin(T * 5)) : 0;
    const hy = 80 + Math.round(down * 7);
    R(ax - 1, 80, 3, hy - 80 + 1, C.ink);
    R(ax, 80, 1, hy - 80 + 1, C.stL);
    R(ax - 5, hy, 11, 6, C.ink);
    R(ax - 4, hy + 1, 9, 4, '#d9502e');
    R(ax - 4, hy + 1, 9, 1, '#f08060');
    if (b && down > 0.97 && !emit.stampHit) {
      emit.stampHit = 1;
      spawn('txt', ax - 3, hy - 6, { s: 'OK', c: C.green, vy: -10, life: 0.8, max: 0.8 });
    }
    if (down < 0.5) emit.stampHit = 0;
  }
  function mFoundry() {
    const b = busy('foundry');
    cylinder(222, 30, 80, 12, C.st, C.stL, C.stD);
    R(234, 47, 6, 5, C.ink); R(234, 48, 6, 3, C.stL);
    const x = 238, y = 46, w = 40, h = 36, f = 14;
    block(x, y, w, h, f, '#5a5f6b', '#7a808c', '#3e434d', '#4a4e57', '#2e3139');
    R(264, 16, 11, 34, C.ink);
    R(265, 18, 9, 31, '#7a4a3a');
    for (let yy = 21; yy < 48; yy += 4) R(265, yy, 9, 1, '#5a3428');
    R(265, 18, 9, 2, '#9a6a5a');
    R(263, 15, 13, 3, C.ink);
    R(264, 16, 11, 1, C.stD);
    disc(248, 54, 4, C.ink);
    disc(248, 54, 3, '#e9edf2');
    const a = -2.6 + (Math.sin(T * (b ? 3.2 : 0.6)) * 0.5 + 0.5) * 2;
    line(248, 54, 248 + Math.cos(a) * 3, 54 + Math.sin(a) * 3, '#d9481f');
    const mx = 250, my = y + h - f + 1, mw = 15, mh = f - 1;
    R(mx - 1, my - 1, mw + 2, mh + 1, C.ink);
    R(mx, my, mw, mh, '#3a0e06');
    for (let k = 0; k < mw; k++) {
      const hg = Math.max(2, Math.round((b ? 9 : 4) + 2 * Math.sin(T * (b ? 11 : 4) + k * 1.7)));
      R(mx + k, my + mh - hg, 1, hg, C.fireD);
      if (hg > 3) R(mx + k, my + mh - hg + 2, 1, hg - 2, C.fire);
      if (hg > 6) R(mx + k, my + mh - hg + 4, 1, hg - 4, C.fireL);
    }
    gear(x + 6, y + h - 6, T * (b ? 5 : 1), C.stL);
    gear(x + w - 6, y + h - 6, -T * (b ? 5 : 1), C.stL);
    every('smoke', b ? 7 : 1.6, () => spawn('smoke', 269 + (Math.random() * 4 - 2), 14, { vx: 5 + Math.random() * 4, vy: -9 - Math.random() * 5, life: 2.6, max: 2.6 }));
    if (b) every('ember', 5, () => spawn('px', 252 + Math.random() * 12, my + 2, { vx: Math.random() * 8 - 4, vy: -14, life: 0.5, max: 0.5, c: C.fireL }));
  }
  function mInspect() {
    const b = busy('inspect');
    const x = 322, y = 50, w = 48, h = 32, f = 10;
    block(x, y, w, h, f, '#7a8696', '#9aa6b6', '#566170', '#c9cfd8', '#9099a6');
    disc(346, y + 10, 8, C.ink);
    disc(346, y + 10, 7, '#2c3440');
    disc(346, y + 10, 5, '#0b1a2a');
    const px = b && !reduce ? Math.round(Math.sin(T * 2.2) * 2) : 0;
    disc(346 + px, y + 10, 2, b ? '#4aa8ff' : '#1f4a74');
    P(345 + px, y + 9, '#cfe8ff');
    disc(x + 5, y + 5, 2, C.ink);
    disc(x + 5, y + 5, 1, b ? (blink(0.5) ? C.green : C.greenD) : C.greenD);
    text('QA', x + 5, y + h - f + 3, C.ink);
    R(x + 34, y + h - f + 2, 10, 6, C.ink);
    R(x + 35, y + h - f + 3, 8, 4, C.glass);
  }
  function oInspect() {
    const b = busy('inspect');
    for (const bx of [337, 354]) { R(bx - 1, 82, 4, 22, C.ink); R(bx, 82, 2, 21, C.stL); }
    R(335, 101, 23, 5, C.ink);
    R(336, 102, 21, 3, C.st);
    if (b) {
      const lx = 340 + Math.round((Math.sin(T * 3) * 0.5 + 0.5) * 12);
      g.globalAlpha = 0.35;
      R(lx - 1, 85, 3, 15, '#ff3b5c');
      g.globalAlpha = 0.9;
      R(lx, 85, 1, 15, '#ff3b5c');
      g.globalAlpha = 1;
    }
  }
  function mTanks() {
    cylinder(404, 40, 78, 9, '#e2b33a', '#f5d36a', '#a9801f');
    cylinder(428, 44, 78, 9, '#e2b33a', '#f5d36a', '#a9801f');
    R(413, 60, 6, 4, C.ink); R(413, 61, 6, 2, C.stL);
    block(446, 58, 20, 22, 8, C.stD, C.st, C.stDD, '#c9cfd8', '#9099a6');
    for (let i = 0; i < 3; i++) P(450 + i * 4, 74, blink(0.4 + i * 0.3) ? [C.green, C.amber, '#ff5a4f'][i] : C.ink);
    R(440, 66, 6, 3, C.ink); R(440, 67, 6, 1, C.stL);
  }
  function mPaint() {
    const b = busy('paint');
    const x = 404, y = 146, w = 48, h = 40, f = 12;
    block(x, y, w, h, f, '#6a5a8a', '#8a7aaa', '#4a3e66', '#d8d2e6', '#a8a0bb');
    for (const [cx, c, cl] of [[415, C.pink, '#ffb0d4'], [441, C.teal, '#9af0e8']]) {
      disc(cx, y + 11, 7, C.ink);
      disc(cx, y + 11, 6, '#b0b8c4');
      disc(cx, y + 11, 4, c);
      const a = T * (b ? 5 : 0.8);
      P(cx + Math.round(Math.cos(a) * 2), y + 11 + Math.round(Math.sin(a) * 2), cl);
    }
    R(426, y + 8, 4, 2, C.ink);
    const cols = [C.pink, C.amber, '#ffe25a', C.green, C.teal, C.blueL];
    for (let i = 0; i < w - 8; i++) R(x + 4 + i, y + h - f + 2, 1, 2, cols[Math.floor((i + (b ? T * 14 : 0)) / 7) % cols.length]);
    text('CAPTION', x + 10, y + h - f + 5, '#4a3e66');
  }
  function oPaint() {
    const b = busy('paint');
    for (const [nx, c] of [[422, C.pink], [434, C.teal]]) {
      R(nx - 1, 184, 3, 6, C.ink);
      R(nx, 184, 1, 5, C.stL);
      R(nx - 2, 189, 5, 2, C.ink);
      if (b) every('spray' + nx, 22, () => spawn('px', nx + Math.random() * 4 - 2, 191, { vx: Math.random() * 10 - 5, vy: 18 + Math.random() * 10, life: 0.35, max: 0.35, c }));
    }
  }
  let pressDown = 0;
  function mLabel() {
    const b = busy('label');
    const x = 304, y = 142, w = 48, h = 44, f = 12;
    block(x, y, w, h, f, '#8a5a3a', '#aa7a52', '#643f26', '#9aa5b5', '#6b7584');
    gear(x + 9, y + 9, T * (b ? 5 : 0.6), C.stL);
    gear(x + 39, y + 9, -T * (b ? 5 : 0.6), C.stL);
    R(x + 17, y + 4, 14, 24, C.ink);
    R(x + 18, y + 5, 12, 22, C.st);
    R(x + 18, y + 5, 12, 1, C.stL);
    R(x + 23, y + 7, 2, 18, C.stL);
    text('#TAG', x + 17, y + h - f + 4, C.ink);
  }
  function oLabel() {
    const b = busy('label');
    const ax = 328;
    const ph = b && !reduce ? (T * 0.8) % 1 : 0;
    const down = ph < 0.5 ? 0 : ph < 0.6 ? (ph - 0.5) / 0.1 : ph < 0.75 ? 1 : 1 - (ph - 0.75) / 0.25;
    const hy = 178 + Math.round(down * 9);
    g.globalAlpha = 0.25 - down * 0.15;
    R(ax - 9, 191, 18, 10, '#000');
    g.globalAlpha = 1;
    R(ax - 2, 178, 4, hy - 178 + 1, C.ink);
    R(ax - 1, 178, 2, hy - 178 + 1, C.stL);
    R(ax - 10, hy, 21, 8, C.ink);
    R(ax - 9, hy + 1, 19, 6, '#e8702a');
    R(ax - 9, hy + 1, 19, 1, '#ffa060');
    text('#', ax - 1, hy + 2, C.ink);
    if (down >= 1 && pressDown < 1) for (let i = 0; i < 8; i++) spawn('px', ax + (i < 4 ? -10 : 10), hy + 6, { vx: (i < 4 ? -1 : 1) * (10 + Math.random() * 25), vy: -10 - Math.random() * 20, life: 0.45, max: 0.45, c: i % 2 ? '#ffd166' : C.white, grav: 60 });
    pressDown = down;
  }
  function mGate() {
    const waiting = (counts.gate || 0) > 0;
    block(222, 160, 22, 26, 9, C.blue, C.blueL, C.blueD, '#d8d2c6', '#a89f90');
    R(226, 179, 14, 6, C.ink);
    R(227, 180, 12, 4, C.glass);
    R(231, 181, 3, 3, C.skin);
    R(231, 180, 3, 1, C.blueD);
    R(247, 164, 7, 17, C.ink);
    R(248, 165, 5, 15, '#2a2d33');
    disc(250, 169, 2, waiting ? (blink(0.8) ? '#ff4a3d' : '#7a1c18') : '#4a1b18');
    disc(250, 176, 2, waiting ? '#12301c' : C.green);
    R(250, 181, 1, 5, C.stDD);
  }
  function oGate() {
    const ang = Math.PI / 2 + (1 - gateA) * (Math.PI / 2);
    const px = 212, py = 186, L = 23;
    const ex = px + Math.cos(ang) * L, ey = py + Math.sin(ang) * L;
    line(px - 1, py - 1, ex - 1, ey - 1, C.ink, 4);
    line(px, py, ex, ey, (i) => (Math.floor(i / 3) % 2 ? C.white : '#d9342c'), 2);
    disc(px, py, 3, C.ink);
    disc(px, py, 2, C.stD);
    P(px, py, C.stL);
  }
  function mScrap() {
    const x = BIN.x, y = BIN.y, w = 30, h = 22, f = 7;
    block(x, y, w, h, f, '#3c6e47', '#5a8e64', '#2a4e33', '#2f5a3a', '#1f3a26');
    R(x + 2, y + 2, w - 4, h - f - 4, '#16171c');
    for (const [a, b2, c] of [[4, 9, '#6b7078'], [9, 10, '#8e949c'], [20, 9, '#6b4426'], [24, 10, '#6b7078'], [14, 10, '#4a4e57']]) P(x + a, y + b2, c);
    text('SCRAP', x + 5, y + h - f + 1, '#cfe3d2');
    disc(x + w - 1, y, 2, C.ink);
    disc(x + w - 1, y, 1, blink(1.4, 0.3) ? '#ff5a4f' : '#6a1c18');
  }
  function mDepot() {
    const x = 40, y = 234, w = 230, h = 34, f = 12;
    block(x, y, w, h, f, C.st, C.stL, C.stD, '#a39a8c', '#7d7468');
    for (let xx = x + 2; xx < x + w; xx += 4) R(xx, y + 1, 1, h - f - 2, '#7d8794');
    R(x, y + 1, w, 1, C.stL);
    R(64, 234, 16, 5, C.ink);
    R(65, 234, 14, 4, '#141519');
    for (const p of PL) {
      const c = BAYS[p];
      const t = trucks[p];
      R(c - 11, y + 4, 22, 15, C.ink);
      text(PL_SHORT[p], c - 3, y + 6, TRUCK[p][1] === '#454852' ? C.teal : TRUCK[p][1]);
      const n = String(last ? last.published[p] || 0 : 0);
      text(n, c - tw(n) / 2, y + 12, C.amber);
      const dx = c - 8, dy = y + h - f + 2;
      R(dx - 1, dy - 1, 18, f - 1, C.ink);
      if (t.state === 'parked' && t.loading) {
        R(dx, dy, 16, f - 2, '#141519');
        drawCrate(c, dy + 8, { lvl: 6 });
      } else for (let i = 0; i < f - 2; i++) R(dx, dy + i, 16, 1, i % 2 ? C.stD : C.stL);
    }
  }
  function drawTruck(p) {
    const t = trucks[p];
    if (t.off >= 46) return;
    const [col, colL, colD] = TRUCK[p];
    const cx = BAYS[p], x = cx - 7, y = 270 + Math.round(t.off);
    shade(x + 2, y + 2, 14, 28);
    R(x - 2, y + 3, 2, 6, C.ink); R(x + 14, y + 3, 2, 6, C.ink);
    R(x - 2, y + 20, 2, 6, C.ink); R(x + 14, y + 20, 2, 6, C.ink);
    R(x - 1, y - 1, 16, 30, C.ink);
    R(x, y, 14, 18, col);
    R(x, y, 14, 2, colL);
    for (let i = 0; i < 3; i++) R(x, y + 6 + i * 4, 14, 1, colD);
    text(PL_SHORT[p], cx - 3, y + 7, p === 'tiktok' ? C.teal : C.white);
    if (p === 'tiktok') { R(x, y, 1, 18, C.teal); R(x + 13, y, 1, 18, C.pink); }
    R(x, y + 19, 14, 9, '#e8eaee');
    R(x, y + 19, 14, 1, C.white);
    R(x + 2, y + 23, 10, 3, C.glass);
    P(x + 3, y + 23, C.white);
    R(x, y + 27, 14, 1, '#9aa3ad');
    const lights = t.loading || t.state !== 'parked';
    if (lights && blink(0.5)) { R(x, y, 2, 1, C.amber); R(x + 12, y, 2, 1, C.amber); }
    P(x + 1, y + 27, '#ffe27a');
    P(x + 12, y + 27, '#ffe27a');
    if (lights) every('ex' + p, t.state === 'parked' ? 3 : 10, () => spawn('smoke', x + 13, y + 22, { vx: 6, vy: -3, life: 1, max: 1, small: true }));
  }
  function mSign() {
    if (!last || !last.dryRun) return;
    const x = 294, y = 214, w = 50, h = 14;
    shade(x + 3, y + 3, w, h + 6);
    R(x + 6, y + h, 3, 7, C.ink); R(x + w - 9, y + h, 3, 7, C.ink);
    R(x + 7, y + h, 1, 6, C.woodD); R(x + w - 8, y + h, 1, 6, C.woodD);
    R(x - 1, y - 1, w + 2, h + 2, C.ink);
    R(x, y, w, h, '#f2c230');
    for (let i = 0; i < w; i += 6) R(x + i, y, 3, 2, C.hazD);
    text('DRY RUN', x + (w - tw('DRY RUN')) / 2, y + 5, C.ink);
    P(x + w - 3, y + h - 3, blink(1) ? '#ff5a4f' : '#7a1c18');
  }
  function drawSign(k, i) {
    const [x, y] = SIGN[k];
    R(x + 3, y + 7, 2, 3, C.ink);
    R(x - 1, y - 1, 10, 9, C.ink);
    R(x, y, 8, 7, C.woodL);
    R(x, y + 6, 8, 1, C.woodD);
    text(String(i + 1), x + 3, y + 1, C.ink);
    const n = counts[k] || 0;
    if (n > 0) {
      const s = 'X' + n;
      R(x + 9, y - 1, tw(s) + 4, 9, C.ink);
      R(x + 10, y, tw(s) + 2, 7, C.amber);
      text(s, x + 11, y + 1, C.ink);
    }
  }

  // ---------- frame ----------
  function update() {
    T += dt;
    gateA += (((counts.gate || 0) > 0 ? 1 : 0) - gateA) * Math.min(1, reduce ? 1 : dt * 3);
    for (const c of crates.values()) {
      if (c.fly) {
        c.fly.t += dt;
        if (c.fly.t >= c.fly.dur || reduce) { c.fly = null; c.bin = true; }
      } else if (!c.bin) {
        const diff = c.target - c.d;
        if (reduce) c.d = c.target;
        else if (Math.abs(diff) > 0.3) c.d += Math.sign(diff) * Math.min(Math.abs(diff), (26 + Math.abs(diff) * 1.4) * dt);
        else c.d = c.target;
      }
      if (reduce) c.alpha = c.leaving ? 0 : 1;
      else c.alpha = c.leaving ? Math.max(0, c.alpha - dt * 2) : Math.min(1, c.alpha + dt * 2.5);
      if (c.shipped && c.d >= TOTAL - 0.5) c.alpha = 0;
    }
    for (const [id, c] of crates) if ((c.leaving || c.shipped) && c.alpha <= 0) crates.delete(id);
    for (const p of PL) {
      const t = trucks[p];
      t.t += dt;
      if (t.state === 'leave') { t.off = Math.pow(Math.min(1, t.t / 1.6), 2) * 50; if (t.t >= 1.6) { t.state = 'away'; t.t = 0; } }
      else if (t.state === 'away') { t.off = 50; if (t.t >= 0.8) { t.state = 'back'; t.t = 0; } }
      else if (t.state === 'back') { const k = Math.min(1, t.t / 1.6); t.off = 50 * Math.pow(1 - k, 2); if (k >= 1) { t.state = 'parked'; t.off = 0; } }
    }
    for (const w of workers) {
      if (w.wait > 0) { w.wait -= dt; continue; }
      const dx = w.tx - w.x, dy = w.ty - w.y, dist = Math.hypot(dx, dy);
      if (dist < 1) {
        w.wait = 1 + Math.random() * 3;
        w.tx = w.z[0] + Math.random() * (w.z[2] - w.z[0]);
        w.ty = w.z[1] + Math.random() * (w.z[3] - w.z[1]);
      } else {
        const sp = Math.min(dist, 13 * dt);
        w.x += (dx / dist) * sp;
        w.y += (dy / dist) * sp;
        if (Math.abs(dx) > 0.5) w.face = dx < 0 ? 1 : 0;
      }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.life -= dt;
      if (q.life <= 0) { parts.splice(i, 1); continue; }
      q.vy += (q.grav || 0) * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  }

  function cratePos(c) {
    if (c.fly) {
      const k = Math.min(1, c.fly.t / c.fly.dur);
      return { x: c.fly.x0 + (c.fly.x1 - c.fly.x0) * k, y: c.fly.y0 + (c.fly.y1 - c.fly.y0) * k - Math.sin(k * Math.PI) * 18 };
    }
    if (c.bin) return binSpot(c.binK);
    const p = at(c.d);
    const idx = STAGES.indexOf(c.slot.stage);
    const arrived = Math.abs(c.target - c.d) < 0.5;
    const hop = arrived && idx >= 1 && idx <= 5 && !reduce && Math.sin(T * 6 + c.d) > 0.75 ? 1 : 0;
    return { x: p.x, y: p.y - hop };
  }

  function draw() {
    g = ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(GROUND, 0, 0);
    // belt slats
    const off = reduce ? 0 : (T * 22) % 6;
    for (let d = off; d < TOTAL; d += 6) {
      const p = at(d);
      if (p.h) R(p.x, p.y - 4, 1, 8, C.beltL);
      else R(p.x - 4, p.y, 8, 1, C.beltL);
    }
    // pond shimmer and a duck
    for (let i = 0; i < 7; i++) {
      const sx = 420 + ((i * 37 + Math.floor(T * 6) * (i % 2 ? 1 : -1)) % 64), sy = 258 + ((i * 13) % 18);
      if (blink(1.1, 0.5, i * 0.37)) R(sx, sy, 2, 1, C.waterL);
    }
    const da = T * 0.25;
    const dxp = 452 + Math.cos(da) * 30, dyp = 266 + Math.sin(da) * 9;
    ctx.drawImage(DUCK[Math.sin(da) > 0 ? 1 : 0], Math.round(dxp) - 3, Math.round(dyp) - 3);
    // machines
    mDock(); mDesign(); mFoundry(); mInspect(); mTanks(); mScrap(); mGate(); mLabel(); mPaint(); mSign();
    // crates
    const list = [...crates.values()].map((c) => ({ c, p: cratePos(c) })).sort((a, b) => (a.c.bin === b.c.bin ? a.p.y - b.p.y : a.c.bin ? -1 : 1));
    for (const { c, p } of list) {
      c.pos = p;
      g.globalAlpha = c.alpha;
      drawCrate(p.x, p.y, { lvl: c.lvl, manual: c.slot.kind === 'manual', grey: c.slot.stage === 'scrap' });
      g.globalAlpha = 1;
    }
    oDesign(); oInspect(); oPaint(); oLabel(); oGate();
    mDepot();
    for (const p of PL) drawTruck(p);
    // crew
    for (const w of [...workers].sort((a, b) => a.y - b.y)) {
      const moving = w.wait <= 0 && !reduce;
      oval(Math.round(w.x), Math.round(w.y), 3, 1, 'rgba(16,28,8,.35)');
      ctx.drawImage(w.crew[w.face][moving ? Math.floor(T * 6) % 2 : 0], Math.round(w.x) - 5, Math.round(w.y) - 13 - (moving && Math.floor(T * 6) % 2 ? 1 : 0));
    }
    // particles
    for (const q of parts) {
      const k = q.life / q.max;
      if (q.kind === 'smoke') {
        const s = q.small ? 1 + Math.round((1 - k) * 2) : 1 + Math.round((1 - k) * 4);
        g.globalAlpha = Math.min(0.75, k * 0.9);
        R(q.x - s / 2, q.y - s / 2, s, s, k > 0.6 ? '#d6d9de' : '#a9aeb6');
      } else if (q.kind === 'txt') {
        g.globalAlpha = Math.min(1, k * 2);
        text(q.s, q.x, q.y, q.c);
      } else {
        g.globalAlpha = Math.min(1, k * 2);
        R(q.x, q.y, 1, 1, q.c);
      }
      g.globalAlpha = 1;
    }
    STAGES.forEach(drawSign);
    // arrival flashes
    for (const k of STAGES) {
      const age = T - (flashAt[k] === undefined ? -9 : flashAt[k]);
      if (age < 0.8 && !reduce) {
        const [x, y, w, h] = AREA[k];
        g.globalAlpha = 1 - age / 0.8;
        outline(x - 3, y - 3, w + 6, h + 6, C.amber);
        g.globalAlpha = 1;
      }
    }
    // hover and selection
    const mark = (o, c) => {
      if (!o) return;
      if (o.type === 'station') { const [x, y, w, h] = AREA[o.id]; outline(x - 2, y - 2, w + 4, h + 4, c); }
      else if (o.type === 'truck') { const x = BAYS[o.id] - 9; outline(x, 268 + Math.round(trucks[o.id].off), 18, 32, c); }
      else { const cr = crates.get(o.id); if (cr && cr.pos) outline(Math.round(cr.pos.x) - 7, Math.round(cr.pos.y) - 9, 14, 14, c); }
    };
    if (selected && (reduce || blink(0.8, 0.7))) mark(selected, C.white);
    if (hover && !(selected && hover.type === selected.type && hover.id === selected.id)) mark(hover, '#ffe25a');
    if (hover) {
      const s = hoverLabel(hover);
      if (s) {
        const box = hoverBox(hover);
        tag(s, box.x + box.w / 2 - (tw(s) + 4) / 2, box.y - 13);
      }
    }
  }
  function outline(x, y, w, h, c) {
    R(x, y, w, 1, c); R(x, y + h - 1, w, 1, c); R(x, y, 1, h, c); R(x + w - 1, y, 1, h, c);
  }

  let prevTs = 0;
  let running = false;
  function frame(ts) {
    if (reduce) {
      running = false;
      dt = 0;
      update();
      draw();
      return;
    }
    dt = prevTs ? Math.min(0.1, (ts - prevTs) / 1000) : 0;
    prevTs = ts;
    update();
    draw();
    requestAnimationFrame(frame);
  }
  function startLoop() {
    if (running) return;
    running = true;
    prevTs = 0;
    requestAnimationFrame(frame);
  }
  const stillBtn = document.querySelector('[data-still]');
  function stillLabel() {
    if (!stillBtn) return;
    stillBtn.textContent = reduce ? 'Play animation' : 'Pause animation';
    stillBtn.setAttribute('aria-pressed', reduce ? 'true' : 'false');
  }
  if (stillBtn) {
    stillBtn.hidden = false;
    stillLabel();
    stillBtn.addEventListener('click', () => {
      reduce = !reduce;
      try { localStorage.setItem('factory-still', reduce ? '1' : '0'); } catch { /* not remembered */ }
      stillLabel();
      if (reduce) { update(); draw(); } else startLoop();
    });
  }

  // ---------- data -> scene ----------
  const el = (tag2, cls, txt) => {
    const e = document.createElement(tag2);
    if (cls) e.className = cls;
    if (txt !== undefined && txt !== null) e.textContent = String(txt);
    return e;
  };
  const board = document.querySelector('[data-board]');
  const insp = document.querySelector('[data-inspector]');
  const hb = document.querySelector('[data-hb]');
  const updated = document.querySelector('[data-updated]');

  function apply(state) {
    last = state;
    tz = state.tz || undefined;
    counts = {};
    for (const s of state.slots) counts[s.stage] = (counts[s.stage] || 0) + 1;
    const groups = {};
    for (const s of state.slots) if (STAGES.includes(s.stage)) (groups[s.stage] = groups[s.stage] || []).push(s);
    const seen = new Set();
    for (const k of Object.keys(groups))
      groups[k].forEach((s, i) => {
        seen.add(s.id);
        const target = ANCHOR[k] - QGAP * Math.min(i, QMAX - 1);
        let c = crates.get(s.id);
        if (!c || c.bin || c.fly) {
          c = { id: s.id, slot: s, d: first || k !== 'dock' ? target : ANCHOR.dock - 16, target, alpha: first ? 1 : 0, lvl: 0 };
          crates.set(s.id, c);
        } else if (c.slot.stage !== k) flashAt[k] = T;
        c.slot = s;
        c.target = target;
        c.leaving = false;
        c.lvl = Math.max(c.lvl, STAGES.indexOf(k));
      });
    // scrap: the latest few sit in the bin; a crate that was on the belt jumps in
    const scrap = state.slots.filter((s) => s.stage === 'scrap').slice(-MAX_SCRAP);
    scrap.forEach((s, k) => {
      seen.add(s.id);
      const spot = binSpot(k);
      let c = crates.get(s.id);
      if (!c) {
        c = { id: s.id, d: 0, target: 0, alpha: 1, lvl: 0, bin: true };
        crates.set(s.id, c);
      } else if (!c.bin && !c.fly) {
        if (c.pos && !first && !reduce) c.fly = { x0: c.pos.x, y0: c.pos.y, x1: spot.x, y1: spot.y, t: 0, dur: 0.9 };
        else c.bin = true;
      }
      c.slot = s;
      c.binK = k;
      c.leaving = false;
      c.alpha = 1;
    });
    // shipped: ride into the depot and disappear
    for (const s of state.slots)
      if (s.stage === 'shipped') {
        const c = crates.get(s.id);
        if (c && !c.bin && !c.fly) {
          seen.add(s.id);
          c.slot = s;
          c.target = TOTAL;
          c.shipped = true;
          c.lvl = 8;
        }
      }
    for (const [id, c] of crates) if (!seen.has(id)) c.leaving = true;
    // trucks
    const waiting = {};
    for (const s of state.slots) if (s.stage === 'shipping') for (const p of s.pubs) if (p.s === 'pending' || p.s === 'uploading') waiting[p.p] = true;
    for (const p of PL) {
      trucks[p].loading = state.uploading[p] > 0 || !!waiting[p];
      if (prevPublished && (state.published[p] || 0) > (prevPublished[p] || 0)) {
        if (trucks[p].state === 'parked') { trucks[p].state = 'leave'; trucks[p].t = 0; }
        spawn('txt', BAYS[p] - 3, 228, { s: '+1', c: C.green, vy: -8, life: 1.4, max: 1.4 });
      }
    }
    prevPublished = Object.assign({}, state.published);
    htmlCounts(state);
    boardRows(state);
    hud(state);
    if (selected) showInspector();
    first = false;
    if (reduce) {
      update();
      draw();
    }
  }

  function htmlCounts(state) {
    for (const k of STAGES) {
      const b = document.querySelector('[data-count="' + k + '"]');
      if (b) b.textContent = String(counts[k] || 0);
      const li = document.querySelector('li[data-station="' + k + '"]');
      if (li) li.classList.toggle('busy', (counts[k] || 0) > 0);
    }
    for (const p of PL) {
      const n = document.querySelector('[data-n="' + p + '"]');
      if (n) n.textContent = String(state.published[p] || 0);
    }
    const sn = document.querySelector('[data-scrapn]');
    if (sn) sn.textContent = String(state.scrapped);
  }

  function boardRows(state) {
    if (!board) return;
    const rows = state.slots.filter((s) => s.stage !== 'shipped' && s.stage !== 'scrap').sort((a, b) => (a.when || '').localeCompare(b.when || ''));
    const out = rows.map((s) => {
      const tr = el('tr');
      const td = el('td', 'nw');
      const b = el('button', 'fx-pick', slotName(s));
      b.type = 'button';
      b.addEventListener('click', () => select({ type: 'crate', id: s.id }));
      td.append(b);
      tr.append(td, el('td', null, NAMES[s.stage]), el('td', null, s.caption), el('td', null, s.pubs.map((p) => PL_NAME[p.p] + ': ' + (PUB_WORD[p.s] || p.s)).join(', ')));
      return tr;
    });
    if (!out.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'The line is empty. Nothing is planned or in production.');
      td.colSpan = 4;
      tr.append(td);
      out.push(tr);
    }
    board.replaceChildren(...out);
  }

  function hud(state) {
    if (hb) {
      const a = state.heartbeatAge;
      hb.textContent = a === null ? 'Factory not started yet' : a > 300 ? 'Factory stopped: no sign of life for a while' : 'Factory running';
      hb.classList.toggle('ok', a !== null && a <= 300);
      hb.classList.toggle('bad', a === null || a > 300);
    }
    if (updated) updated.textContent = 'Updated ' + fmtLocal(state.now).slice(-5);
  }

  function hoverLabel(o) {
    if (o.type === 'station') return NAMES[o.id] + (counts[o.id] ? ' ' + counts[o.id] : '');
    if (o.type === 'truck') return PL_NAME[o.id] + ' ' + ((last && last.published[o.id]) || 0) + ' POSTED';
    const c = crates.get(o.id);
    return c ? (c.slot.kind === 'manual' ? 'MADE NOW' : 'POST ' + c.slot.idx) + ' ' + NAMES[c.slot.stage] : '';
  }
  function hoverBox(o) {
    if (o.type === 'station') { const [x, y, w] = AREA[o.id]; return { x, y, w }; }
    if (o.type === 'truck') return { x: BAYS[o.id] - 9, y: 268, w: 18 };
    const c = crates.get(o.id);
    return c && c.pos ? { x: c.pos.x - 6, y: c.pos.y - 8, w: 12 } : { x: 0, y: 0, w: 0 };
  }

  function showInspector() {
    if (!insp) return;
    const dl = el('dl', 'insp-grid');
    const row = (k, v) => {
      if (v === null || v === undefined || v === '') return;
      dl.append(el('dt', null, k));
      const dd = el('dd');
      if (v instanceof Node) dd.append(v);
      else dd.textContent = String(v);
      dl.append(dd);
    };
    let title = null;
    if (selected && selected.type === 'crate') {
      const c = crates.get(selected.id);
      const s = c ? c.slot : null;
      if (s) {
        title = slotName(s);
        row('Station', NAMES[s.stage]);
        row('Happening', DOING[s.stage]);
        row('Kind', s.kind === 'manual' ? 'Made by hand with Make a video now' : 'Planned daily post');
        row('Tries', s.attempt > 1 ? s.attempt : null);
        row('Waiting for you', s.hold === 'waiting' ? 'Yes: Post it or Discard' : null);
        row('Caption', s.caption);
        row('Error', s.error);
        if (s.pubs.length) {
          const span = el('span');
          for (const p of s.pubs) span.append(el('span', 'chip ' + p.s, PL_NAME[p.p] + ': ' + (PUB_WORD[p.s] || p.s)));
          row('Platforms', span);
        }
      }
    } else if (selected && selected.type === 'station') {
      const k = selected.id;
      title = (STAGES.indexOf(k) + 1) + '. ' + NAMES[k];
      row('What happens', DOING[k]);
      const here = last ? last.slots.filter((s) => s.stage === k).map(slotName) : [];
      row('Videos here', here.length ? here.join(', ') : 'none');
    } else if (selected && selected.type === 'truck') {
      const p = selected.id;
      title = PL_NAME[p] + ' truck';
      row('Posted today', last ? last.published[p] || 0 : 0);
      row('Posting now', last ? last.uploading[p] || 0 : 0);
      row('Loading', trucks[p].loading ? 'yes, a video at the shipping docks is waiting for this platform' : 'no');
    }
    if (!title) {
      insp.replaceChildren(el('p', 'muted', 'Click a crate, a machine or a truck on the floor to see what is happening there.'));
      return;
    }
    const close = el('button', null, 'Close');
    close.type = 'button';
    close.addEventListener('click', () => select(null));
    insp.replaceChildren(el('h3', null, title), dl, close);
  }
  function select(o) {
    selected = o && selected && o.type === selected.type && o.id === selected.id ? null : o;
    showInspector();
    if (reduce) draw();
  }

  // ---------- pointer ----------
  function toLogical(e) {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  }
  const inside = (x, y, a) => x >= a[0] && x <= a[0] + a[2] && y >= a[1] && y <= a[1] + a[3];
  function hit(x, y) {
    const cs = [...crates.values()].filter((c) => c.pos && c.alpha > 0.3).reverse();
    for (const c of cs) if (Math.abs(x - c.pos.x) <= 6 && y >= c.pos.y - 9 && y <= c.pos.y + 4) return { type: 'crate', id: c.id };
    for (const p of PL) if (trucks[p].off < 30 && inside(x, y, [BAYS[p] - 9, 268 + trucks[p].off, 18, 32])) return { type: 'truck', id: p };
    for (const k of STAGES) if (inside(x, y, AREA[k])) return { type: 'station', id: k };
    if (inside(x, y, [BIN.x, BIN.y, 30, 22])) return null;
    return null;
  }
  cv.addEventListener('mousemove', (e) => {
    const p = toLogical(e);
    const h = hit(p.x, p.y);
    const changed = JSON.stringify(h) !== JSON.stringify(hover);
    hover = h;
    cv.classList.toggle('pointer', !!h);
    if (changed && reduce) draw();
  });
  cv.addEventListener('mouseleave', () => {
    hover = null;
    cv.classList.remove('pointer');
    if (reduce) draw();
  });
  cv.addEventListener('click', (e) => {
    const p = toLogical(e);
    select(hit(p.x, p.y));
  });

  // ---------- live data ----------
  let timer = null;
  let stopped = false;
  async function poll() {
    try {
      const r = await fetch('/factory.json', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { accept: 'application/json' } });
      if (r.type === 'opaqueredirect' || r.status === 303 || r.status === 401 || r.status === 403) {
        if (hb) {
          hb.textContent = 'Signed out. Reload the page to sign in again.';
          hb.classList.add('bad');
        }
        stopped = true;
        clearInterval(timer);
        return;
      }
      if (!r.ok) throw new Error('status ' + r.status);
      apply(await r.json());
    } catch {
      if (updated) updated.textContent = 'Connection lost, retrying';
    }
  }

  // ---------- demo shift: made-up crates, nothing is read or written ----------
  function demoShift() {
    const CAPS = ['Cold office? Not anymore.', 'Warm shoulders, no wall socket.', 'Movie night, upgraded.', 'Sweater weather, but heated.', 'My desk chair finally gets it.', 'Wrapped up and plugged in.'];
    const slots = [];
    const published = { youtube: 0, facebook: 0, instagram: 0, tiktok: 0 };
    let seq = 0;
    let scrapped = 0;
    const add = () => {
      seq++;
      slots.push({ id: 'demo#' + seq, name: 'Demo video ' + seq, idx: (seq % 2) + 1, when: new Date().toISOString(), kind: seq % 4 === 0 ? 'manual' : 'planned', stage: 'dock', caption: CAPS[seq % CAPS.length], tier: 't2', attempt: 0, hold: null, error: null, pubs: PL.map((p) => ({ p, s: 'pending' })), wait: 0, age: 0 });
    };
    const inProduction = () => slots.filter((x) => { const j = STAGES.indexOf(x.stage); return j >= 1 && j <= 5; }).length;
    const advance = (s) => {
      if (s.stage === 'dock') {
        if (inProduction() >= 3) return;
        s.attempt = 1;
        s.stage = 'design';
      } else if (s.stage === 'inspect' && Math.random() < 0.12) {
        s.stage = 'scrap';
        s.error = 'Frame check: the product is not visible (demo)';
        scrapped++;
      } else if (s.stage === 'label') {
        if (s.kind === 'manual') {
          s.stage = 'gate';
          s.hold = 'waiting';
        } else s.stage = 'shipping';
      } else if (s.stage === 'gate') {
        if (++s.wait > 2) {
          s.hold = 'approved';
          s.stage = 'shipping';
        }
      } else if (s.stage === 'shipping') {
        for (const p of s.pubs) {
          if (Math.random() < 0.5) continue;
          if (p.s === 'pending') p.s = 'uploading';
          else if (p.s === 'uploading') {
            p.s = 'published';
            published[p.p]++;
          }
        }
        if (s.pubs.every((p) => p.s === 'published')) s.stage = 'shipped';
      } else s.stage = STAGES[STAGES.indexOf(s.stage) + 1];
    };
    for (let i = 0; i < 3; i++) add();
    return () => {
      if (slots.filter((s) => s.stage !== 'shipped' && s.stage !== 'scrap').length < 6 && Math.random() < 0.4) add();
      for (const s of slots) {
        if (s.stage === 'shipped' || s.stage === 'scrap') s.age++;
        else if (Math.random() < 0.5) advance(s);
      }
      for (let i = slots.length - 1; i >= 0; i--) if ((slots[i].stage === 'shipped' && slots[i].age > 2) || (slots[i].stage === 'scrap' && slots[i].age > 30)) slots.splice(i, 1);
      const uploading = {};
      for (const p of PL) uploading[p] = slots.filter((s) => s.stage === 'shipping' && s.pubs.some((x) => x.p === p && x.s === 'uploading')).length;
      return {
        now: new Date().toISOString(),
        dryRun: true,
        heartbeatAge: 2,
        slots: slots.map((s) => ({ id: s.id, name: s.name, idx: s.idx, when: s.when, kind: s.kind, stage: s.stage, caption: s.caption, tier: s.tier, attempt: s.attempt, hold: s.hold, error: s.error, pubs: s.pubs.map((p) => ({ p: p.p, s: p.s })) })),
        published: Object.assign({}, published),
        uploading,
        scrapped,
      };
    };
  }

  if (demo) {
    const step = demoShift();
    apply(step());
    timer = setInterval(() => apply(step()), 2300);
  } else {
    try {
      apply(JSON.parse(cv.dataset.state || 'null'));
    } catch {
      /* the first poll fills it */
    }
    timer = setInterval(() => {
      if (!document.hidden && !stopped) poll();
    }, 4000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !stopped) poll();
    });
  }
  if (reduce) draw();
  else startLoop();
})();
