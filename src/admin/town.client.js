// The town square's only script, served at /town.js. It draws the admin as a pixel-art town on one canvas:
// each building is a page. Walk with the keyboard or click a building to walk there and go in. It reads
// /town.json every 15 s for the HUD and quest markers. It never writes, builds page nodes with createElement
// and textContent only, and only fetches this origin. Every sprite is drawn here in code.
'use strict';
(() => {
  const cv = document.getElementById('town');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;

  // ---------- palette and pixel helpers (the same style as the Factory floor) ----------
  const C = {
    ink: '#1b1c24', grass: '#5c9c3e', grassD: '#4c8a34', grassL: '#72b24c', grassLL: '#8cc65a',
    dirt: '#c8a36a', dirtD: '#a9844f', dirtL: '#dcbd86', stone: '#b9b1a3', stoneL: '#d3ccbf', stoneD: '#948b7c',
    st: '#8e98a6', stL: '#c3cad3', stD: '#5d6673', stDD: '#3e444e',
    red: '#c0393b', redD: '#86252a', redL: '#e2615a', blue: '#2f5fa6', blueD: '#1f4078', blueL: '#5d8fd6',
    wood: '#a8703f', woodD: '#7a4c28', woodL: '#c98e55', amber: '#f5a524', gold: '#ffd84a',
    green: '#3fd47a', pink: '#ff6fae', teal: '#3fd4c9', purple: '#7b4bb3', purpleL: '#a57ad8', purpleD: '#4e2c7a',
    water: '#3a8fd6', waterL: '#8ccaf5', waterD: '#2a6aa6', leaf: '#2f7a3a', leafL: '#46a04c', leafD: '#1f5a2c', trunk: '#6b4426',
    skin: '#f0c39a', glass: '#7cc4f0', white: '#f4f4f4', cream: '#efe6d2', brick: '#a0473a', brickD: '#7a3329',
  };
  let g = ctx;
  const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const P = (x, y, c) => R(x, y, 1, 1, c);
  function disc(cx, cy, r, c) {
    g.fillStyle = c; cx = Math.round(cx); cy = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) { const w = Math.round(Math.sqrt(r * r - dy * dy)); g.fillRect(cx - w, cy + dy, w * 2 + 1, 1); }
  }
  function oval(cx, cy, rx, ry, c) {
    g.fillStyle = c;
    for (let dy = -ry; dy <= ry; dy++) { const w = Math.round(rx * Math.sqrt(1 - (dy * dy) / (ry * ry))); g.fillRect(Math.round(cx) - w, Math.round(cy) + dy, w * 2 + 1, 1); }
  }
  function line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    g.fillStyle = c;
    for (;;) {
      g.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  const shade = (x, y, w, h, a) => { g.fillStyle = 'rgba(16,28,8,' + (a || 0.28) + ')'; g.fillRect(Math.round(x), Math.round(y), w, h); };
  function block(x, y, w, h, f, top, topL, topD, wall, wallD) {
    shade(x + 3, y + 3, w, h);
    R(x - 1, y - 1, w + 2, h + 2, C.ink);
    R(x, y, w, h - f, top); R(x, y, w, 1, topL); R(x, y + h - f - 1, w, 1, topD);
    R(x, y + h - f, w, f, wall); R(x, y + h - 1, w, 1, wallD);
  }
  function outline(x, y, w, h, c) { R(x, y, w, 1, c); R(x, y + h - 1, w, 1, c); R(x, y, 1, h, c); R(x + w - 1, y, 1, h, c); }
  function gear(cx, cy, a, c) {
    disc(cx, cy, 3, C.ink);
    for (let k = 0; k < 4; k++) { const an = a + (k * Math.PI) / 2; R(Math.round(cx + Math.cos(an) * 3.6) - 1, Math.round(cy + Math.sin(an) * 3.6) - 1, 3, 3, C.ink); }
    disc(cx, cy, 2, c);
    for (let k = 0; k < 4; k++) { const an = a + (k * Math.PI) / 2; P(Math.round(cx + Math.cos(an) * 3.6), Math.round(cy + Math.sin(an) * 3.6), c); }
    P(cx, cy, C.ink);
  }
  const FONT = {
    A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
    G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
    M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5],
    S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
    Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], 0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [6, 1, 2, 4, 7], 3: [6, 1, 2, 1, 6],
    4: [5, 5, 7, 1, 1], 5: [7, 4, 6, 1, 6], 6: [3, 4, 6, 5, 2], 7: [7, 1, 2, 2, 2], 8: [2, 5, 2, 5, 2], 9: [2, 5, 3, 1, 6],
    '#': [5, 7, 5, 7, 5], '.': [0, 0, 0, 0, 2], '-': [0, 0, 7, 0, 0], ':': [0, 2, 0, 2, 0], ' ': [0, 0, 0, 0, 0],
    '?': [6, 1, 2, 0, 2], '/': [1, 1, 2, 4, 4], '+': [0, 2, 7, 2, 0], ',': [0, 0, 0, 2, 4], "'": [2, 2, 0, 0, 0], '!': [2, 2, 2, 0, 2], '$': [3, 6, 2, 3, 6],
  };
  const tw = (s) => String(s).length * 4 - 1;
  function text(s, x, y, c) {
    s = String(s).toUpperCase(); g.fillStyle = c; x = Math.round(x); y = Math.round(y);
    for (const ch of s) {
      const gl = FONT[ch] || FONT['?'];
      for (let r = 0; r < 5; r++) { if (gl[r] & 4) g.fillRect(x, y + r, 1, 1); if (gl[r] & 2) g.fillRect(x + 1, y + r, 1, 1); if (gl[r] & 1) g.fillRect(x + 2, y + r, 1, 1); }
      x += 4;
    }
  }
  // A name plate: dark box, light text, clamped inside the canvas.
  function plate(s, cx, y, fg, border) {
    const w = tw(s) + 4;
    const x = Math.max(1, Math.min(W - w - 2, Math.round(cx - w / 2)));
    y = Math.max(1, Math.min(H - 11, Math.round(y)));
    if (border) R(x - 1, y - 1, w + 2, 11, border);
    g.globalAlpha = border ? 1 : 0.82;
    R(x, y, w, 9, C.ink);
    g.globalAlpha = 1;
    text(s, x + 2, y + 2, fg || C.white);
    return { x, y, w };
  }
  function sprite(w, h, paint) {
    const px = Array.from({ length: h }, () => new Array(w).fill(null));
    paint((x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) px[y][x] = c; });
    const s = document.createElement('canvas');
    s.width = w + 2; s.height = h + 2;
    const sg = s.getContext('2d');
    for (let y = -1; y <= h; y++)
      for (let x = -1; x <= w; x++) {
        const on = (a, b) => a >= 0 && b >= 0 && a < w && b < h && px[b][a];
        if (on(x, y)) { sg.fillStyle = px[y][x]; sg.fillRect(x + 1, y + 1, 1, 1); }
        else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) { sg.fillStyle = C.ink; sg.fillRect(x + 1, y + 1, 1, 1); }
      }
    return s;
  }
  const fromMap = (rows, pal) => sprite(rows[0].length, rows.length, (put) => rows.forEach((r, y) => [...r].forEach((ch, x) => { if (pal[ch]) put(x, y, pal[ch]); })));
  function pine(dark) {
    const lf = dark ? ['#3a8a42', '#256b33', '#174a24'] : [C.leafL, C.leaf, C.leafD];
    return sprite(15, 22, (put) => {
      for (let t = 0; t < 3; t++)
        for (let r = 0; r < 8; r++) {
          const half = Math.min(7, 1 + Math.floor(r * 0.75) + t);
          for (let dx = -half; dx <= half; dx++) {
            let c = dx < -half / 3 ? lf[0] : dx > half / 3 ? lf[2] : lf[1];
            if (r === 7 && (dx + t) % 2 === 0) c = lf[2];
            put(7 + dx, t * 5 + r, c);
          }
        }
      for (let y = 18; y < 22; y++) { put(6, y, C.trunk); put(7, y, '#8a5a34'); put(8, y, C.trunk); }
    });
  }
  const TREES = [pine(false), pine(true)];
  const OAK = sprite(17, 18, (put) => {
    for (let y = 0; y < 13; y++) for (let x = 0; x < 17; x++) {
      const dx = (x - 8) / 8.5, dy = (y - 6) / 6.5;
      if (dx * dx + dy * dy <= 1) put(x, y, y < 4 || x < 5 ? C.leafL : y > 9 || x > 12 ? C.leafD : C.leaf);
    }
    for (let y = 12; y < 18; y++) { put(7, y, C.trunk); put(8, y, '#8a5a34'); put(9, y, C.trunk); }
  });
  const BUSH = sprite(9, 6, (put) => {
    for (let y = 0; y < 6; y++) for (let x = 0; x < 9; x++) { const dx = (x - 4) / 4.5, dy = (y - 3) / 3; if (dx * dx + dy * dy <= 1) put(x, y, y < 2 ? C.leafL : y > 3 ? C.leafD : C.leaf); }
    put(2, 2, '#e8504a'); put(6, 3, '#ffd84a');
  });
  const WALK = [
    ['..yyyy..', '.yYYYYy.', '.yyyyyy.', '..ssss..', '..esse..', '..rssr..', '.bbbbbb.', 'sbOOOObs', '..OOOO..', '..OOOO..', '..O..O..', '..d..d..'],
    ['..yyyy..', '.yYYYYy.', '.yyyyyy.', '..ssss..', '..esse..', '..rssr..', '.bbbbbb.', 'sbOOOObs', '..OOOO..', '..OOOO..', '..O.O...', '..dd.d..'],
  ];
  const person = (p) => {
    const pal = { y: p.y, Y: p.Y, s: C.skin, e: C.ink, r: p.r, b: p.b, O: p.O || '#34508a', d: '#3a2a1c' };
    return [WALK.map((m) => fromMap(m, pal)), WALK.map((m) => fromMap(m.map((r) => [...r].reverse().join('')), pal))];
  };
  const HERO = person({ y: '#2fb36a', Y: '#7ef0a8', b: '#f5a524', r: '#f0c39a', O: '#1f4078' });
  const FOLK = [
    person({ y: '#e8b923', Y: '#ffe07a', b: '#2f6fd6', r: '#8a4a22' }),
    person({ y: '#c0393b', Y: '#e2615a', b: '#2e8b57', r: '#f0c39a' }),
    person({ y: '#f4f4f4', Y: '#ffffff', b: '#8a5ac8', r: '#5a3a1a' }),
    person({ y: '#7a4c28', Y: '#a8703f', b: '#c0393b', r: '#f0c39a', O: '#4a4e57' }),
    person({ y: '#1f4078', Y: '#5d8fd6', b: '#d6342c', r: '#f0c39a', O: '#1f4078' }), // the postman
    person({ y: '#7b4bb3', Y: '#a57ad8', b: '#efe6d2', r: '#c99a6a' }), // the bard
  ];

  // ---------- the town plan ----------
  // Each building: its footprint, the door the hero walks into, the route from the square, and its page.
  const B = [
    { id: 'factory', href: '/factory', place: 'FACTORY', page: 'FACTORY', x: 24, y: 18, w: 116, h: 74, door: [82, 92], route: [[228, 108], [82, 108], [82, 96]] },
    { id: 'hall', href: '/settings', place: 'TOWN HALL', page: 'SETTINGS', x: 214, y: 8, w: 116, h: 82, door: [272, 90], route: [[228, 108], [272, 108], [272, 94]] },
    { id: 'market', href: '/products', place: 'MARKET', page: 'PRODUCTS', x: 404, y: 22, w: 116, h: 70, door: [462, 92], route: [[316, 108], [462, 108], [462, 96]] },
    { id: 'post', href: '/posts', place: 'POST OFFICE', page: 'VIDEOS', x: 20, y: 130, w: 92, h: 60, door: [66, 190], route: [[200, 205], [66, 205], [66, 194]] },
    { id: 'music', href: '/music', place: 'MUSIC HALL', page: 'MUSIC', x: 432, y: 130, w: 92, h: 60, door: [478, 190], route: [[344, 205], [478, 205], [478, 194]] },
    { id: 'library', href: '/prompts', place: 'LIBRARY', page: 'WRITING INSTRUCTIONS', x: 26, y: 238, w: 106, h: 54, door: [79, 292], route: [[272, 214], [272, 308], [79, 308], [79, 296]] },
    { id: 'tower', href: '/models', place: 'WIZARD TOWER', page: 'VIDEO MODELS', x: 186, y: 214, w: 50, h: 78, door: [211, 292], route: [[272, 214], [272, 308], [211, 308], [211, 296]] },
    { id: 'board', href: '/activity', place: 'NOTICE BOARD', page: 'ACTIVITY LOG', x: 296, y: 228, w: 34, h: 28, door: [313, 256], route: [[272, 214], [272, 264], [313, 264], [313, 260]] },
    { id: 'archive', href: '/history', place: 'ARCHIVE', page: 'CHANGE HISTORY', x: 404, y: 238, w: 112, h: 54, door: [460, 292], route: [[272, 214], [272, 308], [460, 308], [460, 296]] },
  ];
  const FOUNTAIN = { x: 272, y: 158, r: 22 };
  const HUB = [272, 200];
  const LAMPS = [[196, 122], [348, 122], [196, 196], [348, 196], [150, 312], [394, 312]];
  const STREETS = [[40, 101, 464, 14], [36, 198, 472, 14], [0, 301, W, 14], [265, 205, 15, 100], [272, 257, 46, 13]];

  // ---------- the ground: drawn once ----------
  function mulberry(a) {
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function cobbles(x0, y0, w, h, inside) {
    for (let y = y0; y < y0 + h; y += 4)
      for (let x = x0 - ((y / 4) % 2 ? 3 : 0); x < x0 + w; x += 6) {
        if (inside && !inside(x + 2, y + 1)) continue;
        R(x, y, 6, 4, C.stoneD);
        R(x + 1, y, 5, 3, (x * 7 + y * 3) % 5 === 0 ? C.stoneL : C.stone);
      }
  }
  function buildGround() {
    const s = document.createElement('canvas');
    s.width = W; s.height = H;
    g = s.getContext('2d');
    const rnd = mulberry(1118);
    R(0, 0, W, H, C.grass);
    for (let i = 0; i < 1500; i++) { const k = rnd(); R(rnd() * W, rnd() * H, 1, k < 0.5 ? 2 : 1, k < 0.45 ? C.grassD : k < 0.85 ? C.grassL : C.grassLL); }
    for (let i = 0; i < 80; i++) { const x = Math.round(rnd() * W), y = Math.round(rnd() * H); R(x, y, 1, 2, C.grassD); R(x + 2, y, 1, 2, C.grassD); R(x + 1, y + 1, 1, 2, C.grassD); }
    for (let i = 0; i < 70; i++) P(Math.round(rnd() * W), Math.round(rnd() * H), ['#ffe25a', '#ffffff', '#ff8fb8', '#b8a0ff'][i % 4]);
    // streets: a dirt edge, then cobbles
    for (const [x, y, w, h] of STREETS) R(x - 1, y - 1, w + 2, h + 2, C.dirtD);
    for (const [x, y, w, h] of STREETS) cobbles(x, y, w, h);
    // door paths from each door to its street
    for (const b of B) {
      const end = b.route[b.route.length - 2];
      const [dx, dy] = b.door;
      R(dx - 6, dy, 13, Math.max(0, end[1] - dy + 2), C.dirtD);
      cobbles(dx - 5, dy, 11, Math.max(0, end[1] - dy + 1));
    }
    // the square
    oval(FOUNTAIN.x, FOUNTAIN.y, 96, 50, C.dirtD);
    cobbles(176, 108, 192, 100, (x, y) => ((x - FOUNTAIN.x) / 94) ** 2 + ((y - FOUNTAIN.y) / 48) ** 2 <= 1);
    // flower beds and benches around the square
    for (const [x, y] of [[186, 150], [348, 150]]) { R(x - 1, y - 1, 12, 9, C.woodD); R(x, y, 10, 7, '#6b4a2e'); for (let i = 0; i < 6; i++) P(x + 1 + ((i * 3) % 9), y + 1 + ((i * 2) % 5), ['#ff6fae', '#ffe25a', '#ffffff'][i % 3]); }
    for (const [x, y] of [[230, 196], [300, 196]]) { R(x - 1, y - 1, 16, 6, C.ink); R(x, y, 14, 2, C.woodL); R(x, y + 2, 14, 2, C.wood); R(x + 1, y + 4, 2, 2, C.ink); R(x + 11, y + 4, 2, 2, C.ink); }
    // trees and bushes, back to front
    const trees = [[160, 40], [190, 64], [364, 44], [386, 76], [536, 52], [8, 108], [138, 156], [160, 186], [398, 156], [414, 192], [538, 212], [156, 262], [250, 246], [372, 250], [390, 286], [536, 252], [12, 228], [146, 296]];
    trees.sort((a, b) => a[1] - b[1]);
    trees.forEach(([x, y], i) => {
      oval(x, y, 6, 2, 'rgba(16,28,8,.3)');
      if (i % 3 === 1) g.drawImage(OAK, x - 9, y - 19); else g.drawImage(TREES[i % 2], x - 8, y - 23);
    });
    for (const [x, y] of [[118, 92], [342, 86], [118, 280], [520, 296], [354, 218], [6, 196]]) g.drawImage(BUSH, x, y);
    g = ctx;
    return s;
  }
  const GROUND = buildGround();

  // ---------- state ----------
  let state = null;
  try { state = JSON.parse(cv.dataset.state || 'null'); } catch { /* the first poll fills it */ }
  let T = 0;
  let dt = 0;
  let hover = null;
  let ready = null; // the building whose door the hero stands at
  let entering = null;
  let upHeld = 0;
  const parts = [];
  const emit = {};
  const hero = { x: HUB[0], y: HUB[1] + 6, face: 0, moving: false, auto: null };
  const folk = [
    { sp: FOLK[0], zone: [60, 104, 440, 112], x: 120, y: 108 },
    { sp: FOLK[1], zone: [190, 120, 354, 196], x: 220, y: 180 },
    { sp: FOLK[2], zone: [40, 302, 500, 312], x: 340, y: 308 },
    { sp: FOLK[3], zone: [120, 200, 420, 210], x: 400, y: 205 },
  ].map((f) => ({ ...f, tx: f.x, ty: f.y, wait: Math.random() * 2, face: 0 }));
  const postman = { sp: FOLK[4], x: 96, y: 206, face: 1 };
  const bard = { sp: FOLK[5], x: 452, y: 206, face: 0 };
  const blink = (period, duty, ph) => ((T + (ph || 0)) % period) / period < (duty === undefined ? 0.5 : duty);
  const night = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h < 6 || h >= 20 ? 1 : h < 7 ? 7 - h : h >= 19 ? h - 19 : 0; };

  function spawn(kind, x, y, o) { if (parts.length < 240) parts.push(Object.assign({ kind, x, y, vx: 0, vy: 0, life: 1, max: 1 }, o)); }
  function every(key, rate, fn) { emit[key] = (emit[key] || 0) + dt * rate; while (emit[key] >= 1) { emit[key]--; fn(); } }

  // Which buildings carry a quest marker.
  function questOf(id) {
    if (!state) return null;
    if (id === 'post' && state.waiting) return '!';
    if (id === 'board' && state.attention) return '!';
    if (id === 'market' && !state.products.total) return '!';
    if (id === 'hall' && (state.refused || !state.platforms.length)) return '!';
    if (id === 'factory' && !state.alive) return '!';
    return null;
  }

  // ---------- buildings ----------
  const byId = Object.fromEntries(B.map((b) => [b.id, b]));
  const lit = () => night() > 0.4;
  const win = (x, y, w, h) => { R(x - 1, y - 1, w + 2, h + 2, C.ink); R(x, y, w, h, lit() ? '#ffd86b' : C.glass); if (!lit()) P(x, y, C.white); };

  function dFactory() {
    const b = byId.factory, { x, y, w, h } = b, f = 18;
    block(x, y, w, h, f, '#6b7280', '#8b93a0', '#4b5260', C.brick, C.brickD);
    for (let i = 0; i < 5; i++) { const sx = x + 2 + i * 23; R(sx, y + 4, 20, 3, C.glass); R(sx, y + 7, 20, 2, '#4b5260'); R(sx, y + 9, 20, 18, '#7a828f'); for (let k = 0; k < 18; k += 3) R(sx, y + 10 + k, 20, 1, '#6b7280'); }
    for (let yy = y + h - f + 2; yy < y + h - 1; yy += 3) for (let xx = x + ((yy / 3) % 2 ? 0 : 3); xx < x + w; xx += 6) R(xx, yy, 1, 2, C.brickD);
    for (const cx of [x + 18, x + 98]) win(cx - 6, y + h - 13, 12, 7);
    const [dx] = b.door;
    R(dx - 10, y + h - f + 3, 20, f - 3, C.ink);
    for (let i = 0; i < f - 4; i++) R(dx - 9, y + h - f + 4 + i, 18, 1, i % 2 ? C.stD : C.stL);
    gear(x + 36, y + h - 9, T * 2, C.stL);
    gear(x + 80, y + h - 9, -T * 2, C.stL);
    for (const [cx, top] of [[x + 14, y - 14], [x + 30, y - 8]]) {
      R(cx - 4, top, 9, y - top + 6, C.ink); R(cx - 3, top + 1, 7, y - top + 5, C.brick); R(cx - 5, top - 2, 11, 3, C.ink);
      every('smoke' + cx, state && state.alive ? 3 : 0.8, () => spawn('smoke', cx + Math.random() * 3 - 1, top - 3, { vx: 4 + Math.random() * 3, vy: -8 - Math.random() * 4, life: 2.6, max: 2.6 }));
    }
  }
  function dHall() {
    const b = byId.hall, { x, y, w, h } = b, f = 24;
    block(x, y, w, h, f, C.blue, C.blueL, C.blueD, '#d8d2c6', '#a89f90');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, C.blueD);
    // clock with the viewer's time
    const cx = x + w / 2, cy = y + 24;
    disc(cx, cy, 10, C.ink); disc(cx, cy, 9, '#f4efe4');
    for (let k = 0; k < 12; k++) P(cx + Math.round(Math.cos((k * Math.PI) / 6) * 7), cy + Math.round(Math.sin((k * Math.PI) / 6) * 7), C.stD);
    const d = new Date(), hr = ((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6) - Math.PI / 2, mn = d.getMinutes() * (Math.PI / 30) - Math.PI / 2;
    line(cx, cy, cx + Math.cos(hr) * 4, cy + Math.sin(hr) * 4, C.ink);
    line(cx, cy, cx + Math.cos(mn) * 6, cy + Math.sin(mn) * 6, C.redD);
    // flag
    R(x + w - 14, y - 18, 1, 22, C.stDD);
    const wave = Math.floor(T * 4) % 2;
    R(x + w - 13, y - 18 + wave, 12, 7, C.amber); R(x + w - 13, y - 15 + wave, 12, 1, C.red);
    // columns and steps
    for (let i = 0; i < 6; i++) { const px = x + 8 + i * 20; if (Math.abs(px + 2 - b.door[0]) < 12) continue; R(px, y + h - f + 2, 5, f - 4, '#efe9dd'); R(px + 4, y + h - f + 2, 1, f - 4, '#b8b0a2'); }
    R(b.door[0] - 9, y + h - f + 6, 18, f - 6, C.ink); R(b.door[0] - 8, y + h - f + 7, 7, f - 7, C.woodD); R(b.door[0] + 1, y + h - f + 7, 7, f - 7, C.woodD); P(b.door[0] - 2, y + h - 10, C.gold); P(b.door[0] + 1, y + h - 10, C.gold);
    R(x - 2, y + h, w + 4, 2, '#a89f90');
    gear(x + 16, y + 40, T, C.gold);
  }
  function dMarket() {
    const b = byId.market, { x, y, w, h } = b, f = 26;
    block(x, y, w, h, f, C.wood, C.woodL, C.woodD, C.cream, '#c9bfa8');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, C.woodD);
    // striped awning with a scalloped edge
    const ay = y + h - f - 2;
    R(x - 3, ay - 1, w + 6, 9, C.ink);
    for (let i = 0; i < w + 4; i++) R(x - 2 + i, ay, 1, 7, Math.floor(i / 6) % 2 ? C.white : C.red);
    for (let i = 0; i < w + 4; i += 6) { R(x - 2 + i, ay + 7, 6, 1, C.ink); R(x - 1 + i, ay + 7, 4, 1, Math.floor(i / 6) % 2 ? C.white : C.red); }
    // the counter holds one crate per product in turn
    const n = state ? Math.min(6, state.products.on) : 2;
    R(x + 6, y + h - 9, 34, 6, C.woodD); R(x + w - 40, y + h - 9, 34, 6, C.woodD);
    for (let i = 0; i < n; i++) {
      const cx = i < 3 ? x + 8 + i * 11 : x + w - 38 + (i - 3) * 11, cy = y + h - 16;
      R(cx - 1, cy - 1, 10, 9, C.ink); R(cx, cy, 8, 7, ['#d29a5a', C.pink, C.teal, C.gold, C.green, C.purpleL][i]); R(cx + 3, cy, 2, 7, C.white);
    }
    R(b.door[0] - 7, y + h - 18, 14, 17, C.ink); R(b.door[0] - 6, y + h - 17, 12, 16, C.woodD); P(b.door[0] + 3, y + h - 9, C.gold);
    R(x + w / 2 - 18, y + 6, 36, 9, C.ink); text('MARKET', x + w / 2 - 11, y + 8, C.gold);
  }
  function dPost() {
    const b = byId.post, { x, y, w, h } = b, f = 20;
    block(x, y, w, h, f, C.red, C.redL, C.redD, C.cream, '#c9bfa8');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, C.redD);
    // envelope sign
    R(x + w / 2 - 9, y + 10, 18, 12, C.ink); R(x + w / 2 - 8, y + 11, 16, 10, C.white); line(x + w / 2 - 8, y + 11, x + w / 2, y + 16, C.stD); line(x + w / 2 + 7, y + 11, x + w / 2, y + 16, C.stD);
    win(x + 8, y + h - 14, 12, 8);
    R(b.door[0] - 7, y + h - 17, 14, 16, C.ink); R(b.door[0] - 6, y + h - 16, 12, 15, '#2f5fa6'); P(b.door[0] + 3, y + h - 9, C.gold);
    // the mailbox raises its flag while a video waits for Post or Discard
    const mx = x + w - 10, my = y + h + 2;
    R(mx - 1, my - 1, 10, 8, C.ink); R(mx, my, 8, 6, C.blue); R(mx, my, 8, 1, C.blueL); R(mx + 3, my + 7, 2, 4, C.ink);
    if (state && state.waiting) { R(mx + 8, my - 6, 1, 7, C.ink); R(mx + 9, my - 6, 4, 3, C.red); }
  }
  function dMusic() {
    const b = byId.music, { x, y, w, h } = b, f = 20;
    block(x, y, w, h, f, C.purple, C.purpleL, C.purpleD, '#e8dcf2', '#b8a8cc');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, C.purpleD);
    disc(x + w / 2, y + 18, 9, C.ink); disc(x + w / 2, y + 18, 8, lit() ? '#ffd86b' : C.glass);
    R(x + w / 2 - 1, y + 12, 2, 9, C.ink); R(x + w / 2 - 1, y + 12, 5, 2, C.ink); disc(x + w / 2 - 3, y + 21, 2, C.ink);
    R(b.door[0] - 7, y + h - 17, 14, 16, C.ink); R(b.door[0] - 6, y + h - 16, 12, 15, C.woodD);
    win(x + 8, y + h - 14, 10, 8); win(x + w - 18, y + h - 14, 10, 8);
    every('notes', 1.4, () => spawn('note', x + w / 2 + (Math.random() * 30 - 15), y + 4, { vx: Math.random() * 8 - 4, vy: -10, life: 2.2, max: 2.2, c: [C.pink, C.gold, C.teal][Math.floor(Math.random() * 3)] }));
  }
  function dLibrary() {
    const b = byId.library, { x, y, w, h } = b, f = 20;
    block(x, y, w, h, f, '#2f8f8a', '#53b3ad', '#1f6460', '#d9c7a0', '#b39f78');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, '#1f6460');
    // open book sign
    R(x + w / 2 - 10, y + 8, 20, 12, C.ink); R(x + w / 2 - 9, y + 9, 8, 10, C.white); R(x + w / 2 + 1, y + 9, 8, 10, C.white);
    for (let i = 0; i < 4; i++) { R(x + w / 2 - 8, y + 11 + i * 2, 6, 1, C.stD); R(x + w / 2 + 2, y + 11 + i * 2, 6, 1, C.stD); }
    // shelves seen through the windows
    for (const wx of [x + 8, x + w - 30]) {
      R(wx - 1, y + h - 16, 24, 12, C.ink);
      for (let i = 0; i < 22; i++) R(wx + i, y + h - 15, 1, 5, ['#c0393b', '#2f5fa6', '#ffd84a', '#2e8b57', '#7b4bb3'][(i * 7) % 5]);
      R(wx, y + h - 10, 22, 1, C.woodD);
      for (let i = 0; i < 22; i++) R(wx + i, y + h - 9, 1, 4, ['#2e8b57', '#c0393b', '#7b4bb3', '#2f5fa6', '#ffd84a'][(i * 3) % 5]);
      if (lit()) { g.globalAlpha = 0.35; R(wx, y + h - 15, 22, 10, '#ffd86b'); g.globalAlpha = 1; }
    }
    R(b.door[0] - 7, y + h - 17, 14, 16, C.ink); R(b.door[0] - 6, y + h - 16, 12, 15, C.woodD); P(b.door[0] + 3, y + h - 9, C.gold);
  }
  function dTower() {
    const b = byId.tower, { x, y, w, h } = b, cx = x + w / 2, top = y + 30;
    shade(x + 3, top + 3, w, h - 30);
    R(x - 1, top, w + 2, h - 30 + 1, C.ink);
    for (let i = 0; i < w; i++) { const k = (i - w / 2) / (w / 2); R(x + i, top, 1, h - 30, k < -0.5 ? '#6b6f7a' : k < 0.2 ? '#9aa0ab' : k < 0.6 ? '#848a96' : '#5d616c'); }
    for (let yy = top + 6; yy < y + h; yy += 7) for (let xx = x + ((yy / 7) % 2 ? 2 : 7); xx < x + w; xx += 10) R(xx, yy, 6, 1, '#5d616c');
    // stepped cone roof
    for (let i = 0; i < 32; i++) { const half = Math.round(((i + 2) / 34) * (w / 2 + 6)); R(cx - half - 1, y + i - 2, half * 2 + 2, 1, C.ink); R(cx - half, y + i - 2, half * 2, 1, i % 4 === 0 ? C.purpleD : i < 10 ? C.purpleL : C.purple); }
    // the orb glows and throws sparks
    const pulse = 0.5 + 0.5 * Math.sin(T * 3);
    g.globalAlpha = 0.25 + pulse * 0.25; disc(cx, y - 8, 8, C.teal); g.globalAlpha = 1;
    disc(cx, y - 8, 4, C.ink); disc(cx, y - 8, 3, pulse > 0.5 ? '#9ff7ef' : C.teal); P(cx - 1, y - 10, C.white);
    every('spark', 3, () => spawn('px', cx + Math.random() * 10 - 5, y - 8, { vx: Math.random() * 16 - 8, vy: -6 - Math.random() * 10, life: 0.9, max: 0.9, c: Math.random() < 0.5 ? '#9ff7ef' : C.gold }));
    win(cx - 2, top + 10, 4, 8); win(cx - 2, top + 26, 4, 8);
    R(b.door[0] - 6, y + h - 14, 12, 14, C.ink); R(b.door[0] - 5, y + h - 13, 10, 13, C.purpleD); P(b.door[0] + 2, y + h - 7, C.gold);
  }
  function dBoard() {
    const b = byId.board, { x, y, w, h } = b;
    shade(x + 3, y + 3, w, h);
    R(x + 3, y + 12, 3, h - 10, C.ink); R(x + w - 6, y + 12, 3, h - 10, C.ink); R(x + 4, y + 12, 1, h - 11, C.woodD); R(x + w - 5, y + 12, 1, h - 11, C.woodD);
    R(x - 1, y - 1, w + 2, 20, C.ink); R(x, y, w, 18, C.wood); R(x, y, w, 1, C.woodL); R(x - 3, y - 3, w + 6, 3, C.ink); R(x - 2, y - 2, w + 4, 1, C.woodD);
    const n = state ? Math.min(6, Math.max(1, state.chat.length)) : 3;
    for (let i = 0; i < n; i++) { const nx = x + 3 + (i % 3) * 10, ny = y + 2 + Math.floor(i / 3) * 8; R(nx, ny, 8, 6, i === 0 && state && state.attention ? '#ffd9d2' : C.white); R(nx + 1, ny + 2, 5, 1, C.stD); P(nx + 3, ny, C.red); }
  }
  function dArchive() {
    const b = byId.archive, { x, y, w, h } = b, f = 22;
    block(x, y, w, h, f, '#4b5260', '#6b7280', '#33373f', '#9aa0a8', '#6b7078');
    for (let yy = y + 3; yy < y + h - f - 2; yy += 4) R(x, yy, w, 1, '#33373f');
    for (let i = 0; i < 6; i++) { const px = x + 6 + i * 19; if (Math.abs(px + 2 - b.door[0]) < 12) continue; R(px, y + h - f + 2, 5, f - 4, '#c3c7cd'); R(px + 4, y + h - f + 2, 1, f - 4, '#7d828a'); }
    // hourglass sign
    const hx = x + w / 2, hy = y + 12;
    R(hx - 6, hy - 1, 12, 2, C.ink); R(hx - 6, hy + 13, 12, 2, C.ink);
    for (let i = 0; i < 6; i++) { R(hx - 5 + i, hy + 1 + i, 10 - i * 2, 1, i < 3 ? C.gold : '#e8dcc0'); R(hx - 5 + i, hy + 12 - i, 10 - i * 2, 1, i < 2 ? C.gold : '#e8dcc0'); }
    if (blink(1.2)) P(hx, hy + 7, C.gold);
    R(b.door[0] - 8, y + h - f + 5, 16, f - 5, C.ink);
    for (let i = 0; i < 4; i++) R(b.door[0] - 7 + i * 4, y + h - f + 6, 2, f - 6, '#3e444e');
  }
  function dFountain() {
    const { x, y, r } = FOUNTAIN;
    oval(x + 2, y + 3, r + 1, r - 8, 'rgba(16,28,8,.25)');
    oval(x, y, r + 1, r - 7, C.ink); oval(x, y, r, r - 8, C.stL); oval(x, y, r - 3, r - 11, C.water);
    for (let i = 0; i < 3; i++) { const k = ((T * 0.6 + i / 3) % 1); g.globalAlpha = 1 - k; outline(x - Math.round(4 + k * 12), y - Math.round(2 + k * 5), Math.round(8 + k * 24), Math.round(4 + k * 10), C.waterL); g.globalAlpha = 1; }
    R(x - 2, y - 10, 5, 12, C.ink); R(x - 1, y - 9, 3, 11, C.stL); disc(x, y - 11, 3, C.ink); disc(x, y - 11, 2, C.stL);
    every('spray', 14, () => spawn('drop', x, y - 13, { vx: Math.random() * 24 - 12, vy: -18 - Math.random() * 8, life: 0.8, max: 0.8, grav: 60, c: Math.random() < 0.5 ? C.waterL : C.white }));
  }
  function dLamp([x, y]) {
    R(x - 1, y - 14, 3, 15, C.ink); R(x, y - 13, 1, 14, C.stD); R(x - 3, y - 18, 7, 5, C.ink); R(x - 2, y - 17, 5, 3, night() > 0.3 && blink(0.2, 0.95, x) ? '#ffe9a0' : '#d8d2c6');
  }
  function glows() {
    const n = night();
    if (n <= 0) return;
    g.globalAlpha = n * 0.45; R(0, 0, W, H, '#14193a'); g.globalAlpha = 1;
    for (const [x, y] of LAMPS) { g.globalAlpha = n * 0.28; disc(x, y - 15, 14, '#ffd86b'); g.globalAlpha = n * 0.4; disc(x, y - 15, 7, '#ffe9a0'); g.globalAlpha = 1; }
  }

  // ---------- people ----------
  function drawPerson(p, sp, moving) {
    const f = moving ? Math.floor(T * 6) % 2 : 0;
    oval(Math.round(p.x), Math.round(p.y), 3, 1, 'rgba(16,28,8,.35)');
    ctx.drawImage(sp[p.face][f], Math.round(p.x) - 5, Math.round(p.y) - 13 - (moving && f ? 1 : 0));
  }
  function bubble(s, x, y) {
    const w = tw(s) + 6;
    const bx = Math.max(1, Math.min(W - w - 1, Math.round(x - w / 2))), by = Math.round(y);
    R(bx - 1, by - 1, w + 2, 11, C.ink); R(bx, by, w, 9, C.white); R(Math.round(x) - 1, by + 9, 3, 2, C.ink); P(Math.round(x), by + 9, C.white);
    text(s, bx + 3, by + 2, C.ink);
  }

  // ---------- movement ----------
  const solid = (x, y) => {
    if (x < 6 || x > W - 6 || y < 16 || y > H - 3) return true;
    if (((x - FOUNTAIN.x) / (FOUNTAIN.r + 2)) ** 2 + ((y - FOUNTAIN.y) / (FOUNTAIN.r - 6)) ** 2 < 1) return true;
    return B.some((b) => x > b.x - 1 && x < b.x + b.w + 1 && y > b.y - 4 && y < b.y + b.h + 1);
  };
  const atDoor = (x, y) => B.find((b) => Math.abs(x - b.door[0]) <= 8 && y >= b.door[1] && y <= b.door[1] + 12) || null;
  function walkTo(b) {
    const first = b.route[0];
    const pts = Math.hypot(hero.x - first[0], hero.y - first[1]) > 40 && Math.hypot(hero.x - b.door[0], hero.y - b.door[1]) > 30 ? [HUB, ...b.route] : b.route;
    hero.auto = { pts: pts.map((p) => [p[0], p[1]]), i: 0, b };
  }
  function enter(b) {
    if (entering) return;
    entering = { b, t: 0 };
    hero.auto = null;
  }
  const keys = new Set();
  const KEY = { arrowup: 'u', w: 'u', arrowdown: 'd', s: 'd', arrowleft: 'l', a: 'l', arrowright: 'r', d: 'r' };
  const typing = (t) => t && t.closest && t.closest('input, textarea, select, button, a, summary');
  addEventListener('keydown', (e) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = KEY[e.key.toLowerCase()];
    if (k) { keys.add(k); hero.auto = null; e.preventDefault(); return; }
    if ((e.key === 'e' || e.key === 'E' || e.key === 'Enter' || e.key === ' ') && ready) { enter(ready); e.preventDefault(); }
  });
  addEventListener('keyup', (e) => { const k = KEY[e.key.toLowerCase()]; if (k) keys.delete(k); });
  addEventListener('blur', () => keys.clear());

  function update() {
    T += dt;
    if (entering) {
      entering.t += dt;
      if (entering.t > 0.55 && !entering.gone) { entering.gone = true; location.href = entering.b.href; }
      return;
    }
    let vx = 0, vy = 0;
    if (keys.has('l')) vx -= 1; if (keys.has('r')) vx += 1; if (keys.has('u')) vy -= 1; if (keys.has('d')) vy += 1;
    let ghost = false;
    let left = Infinity; // distance to the next route point, so a step never overshoots it
    if (!vx && !vy && hero.auto) {
      const a = hero.auto, [tx, ty] = a.pts[a.i];
      const dx = tx - hero.x, dy = ty - hero.y, d = Math.hypot(dx, dy);
      if (d < 1.5) {
        a.i++;
        if (a.i >= a.pts.length) { hero.auto = null; if (a.b) enter(a.b); }
      } else { vx = dx / d; vy = dy / d; ghost = !!a.b; left = d; }
    }
    const len = Math.hypot(vx, vy);
    hero.moving = len > 0;
    if (len) {
      const sp = Math.min(left, (ghost ? 70 : 55) * dt);
      const nx = hero.x + (vx / len) * sp, ny = hero.y + (vy / len) * sp;
      if (ghost || !solid(nx, hero.y)) hero.x = nx;
      if (ghost || !solid(hero.x, ny)) hero.y = ny;
      if (Math.abs(vx) > 0.2) hero.face = vx < 0 ? 1 : 0;
      if (!ghost && hero.auto && solid(nx, ny) && solid(hero.x + (vx / len) * sp, hero.y + (vy / len) * sp)) hero.auto = null;
    }
    ready = atDoor(hero.x, hero.y);
    // Walking up into a door goes in, like stepping through it.
    if (ready && keys.has('u') && !keys.has('d')) { upHeld += dt; if (upHeld > 0.25) enter(ready); } else upHeld = 0;
    for (const f of folk) {
      if (f.wait > 0) { f.wait -= dt; continue; }
      const dx = f.tx - f.x, dy = f.ty - f.y, d = Math.hypot(dx, dy);
      if (d < 1) { f.wait = 1 + Math.random() * 3; f.tx = f.zone[0] + Math.random() * (f.zone[2] - f.zone[0]); f.ty = f.zone[1] + Math.random() * (f.zone[3] - f.zone[1]); }
      else { const s = Math.min(d, 14 * dt); f.x += (dx / d) * s; f.y += (dy / d) * s; if (Math.abs(dx) > 0.5) f.face = dx < 0 ? 1 : 0; }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i];
      q.life -= dt;
      if (q.life <= 0) { parts.splice(i, 1); continue; }
      q.vy += (q.grav || 0) * dt; q.x += q.vx * dt; q.y += q.vy * dt;
    }
  }

  function draw() {
    g = ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(GROUND, 0, 0);
    // cloud shadows drift over the town
    for (let i = 0; i < 3; i++) { const cx = ((T * 6 + i * 230) % (W + 200)) - 100, cy = 60 + i * 90; oval(cx, cy, 40, 14, 'rgba(16,28,8,.08)'); }
    dFountain();
    // buildings and people, back to front by their base line
    const things = [
      ...B.map((b) => ({ y: b.y + b.h, draw: { factory: dFactory, hall: dHall, market: dMarket, post: dPost, music: dMusic, library: dLibrary, tower: dTower, board: dBoard, archive: dArchive }[b.id] })),
      ...LAMPS.map((l) => ({ y: l[1], draw: () => dLamp(l) })),
      ...folk.map((f) => ({ y: f.y, draw: () => drawPerson(f, f.sp, f.wait <= 0) })),
      { y: postman.y, draw: () => drawPerson(postman, postman.sp, false) },
      { y: bard.y, draw: () => { drawPerson(bard, bard.sp, false); every('bardnote', 1.2, () => spawn('note', bard.x + 3, bard.y - 14, { vx: 6, vy: -9, life: 1.6, max: 1.6, c: C.pink })); } },
      { y: hero.y, draw: () => { oval(Math.round(hero.x), Math.round(hero.y) + 1, 5, 2, 'rgba(63,212,122,.5)'); drawPerson(hero, HERO, hero.moving); } },
    ].sort((a, b) => a.y - b.y);
    for (const t of things) t.draw();
    // particles
    for (const q of parts) {
      const k = q.life / q.max;
      if (q.kind === 'smoke') { const s = 1 + Math.round((1 - k) * 4); g.globalAlpha = Math.min(0.7, k * 0.9); R(q.x - s / 2, q.y - s / 2, s, s, k > 0.6 ? '#d6d9de' : '#a9aeb6'); }
      else if (q.kind === 'note') { g.globalAlpha = Math.min(1, k * 2); R(q.x, q.y - 3, 1, 4, q.c); R(q.x - 2, q.y, 2, 2, q.c); R(q.x, q.y - 3, 2, 1, q.c); }
      else { g.globalAlpha = Math.min(1, k * 2); R(q.x, q.y, 1, 1, q.c); }
      g.globalAlpha = 1;
    }
    glows();
    // name plates, quest markers and speech
    for (const b of B) {
      const isHover = hover === b || ready === b;
      const py = b.id === 'tower' ? b.y - 30 : b.y - 13;
      const pl = plate(b.place, b.x + b.w / 2, Math.max(1, py), isHover ? C.gold : C.white, isHover ? C.gold : null);
      if (isHover) plate(b.page, b.x + b.w / 2, pl.y + 12, C.white, C.ink);
      const q = questOf(b.id);
      if (q) {
        const bob = Math.round(Math.sin(T * 4) * 2), qx = b.x + b.w / 2, qy = Math.max(2, pl.y - 12 + bob);
        R(qx - 3, qy - 1, 7, 11, C.ink); R(qx - 2, qy, 5, 9, C.gold); R(qx, qy + 1, 1, 4, C.ink); R(qx, qy + 7, 1, 1, C.ink);
      }
    }
    if (state && state.waiting) bubble(state.waiting + ' VIDEO' + (state.waiting === 1 ? '' : 'S') + ' WAIT FOR YOU', postman.x, postman.y - 27);
    if (state && state.attention && blink(4, 0.6)) bubble('HEAR YE! ' + state.attention + ' POST' + (state.attention === 1 ? '' : 'S') + ' STUCK', byId.board.x + 17, byId.board.y - 38);
    plate('YOU', hero.x, hero.y - 24, '#7ef0a8');
    if (ready && !entering) plate('E: ENTER ' + ready.place, hero.x, hero.y + 4, C.gold, C.gold);
    if (hover) outline(hover.x - 3, hover.y - 3, hover.w + 6, hover.h + 6, C.gold);
    if (entering) {
      g.globalAlpha = Math.min(1, entering.t / 0.5); R(0, 0, W, H, '#0e0f14'); g.globalAlpha = 1;
      plate('ENTERING ' + entering.b.place + '...', W / 2, H / 2 - 5, C.gold);
    }
  }

  // ---------- pointer ----------
  function toLogical(e) { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height }; }
  const buildingAt = (x, y) => B.find((b) => x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 16 && y <= b.y + b.h + 4) || null;
  cv.addEventListener('mousemove', (e) => { const p = toLogical(e); hover = buildingAt(p.x, p.y); cv.classList.toggle('pointer', !!hover); });
  cv.addEventListener('mouseleave', () => { hover = null; cv.classList.remove('pointer'); });
  cv.addEventListener('click', (e) => {
    cv.focus({ preventScroll: true });
    const p = toLogical(e);
    const b = buildingAt(p.x, p.y);
    if (b) walkTo(b);
    else hero.auto = { pts: [[p.x, p.y]], i: 0, b: null };
  });

  // ---------- the HUD ----------
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = String(txt); return e; };
  const money = (n) => '$' + Number(n).toFixed(2);
  const hhmm = (ts) => (ts ? ts.slice(11, 16) : '');
  function hud(s) {
    const set = (sel, v) => { const e = document.querySelector(sel); if (e) e.textContent = v; };
    const spent = s.spend.llm + s.spend.clips, cap = s.spend.llmCap + s.spend.clipCap;
    set('[data-gold]', money(spent));
    set('[data-v="hp"]', s.age === null ? 'never checked in' : s.alive ? 'running' : 'quiet ' + s.age + ' s');
    set('[data-v="mp"]', money(cap - spent) + ' left');
    const fill = (k, v) => { const e = document.querySelector('[data-fill="' + k + '"]'); if (e) e.style.setProperty('width', Math.max(0, Math.min(100, v)) + '%'); };
    fill('hp', s.alive ? 100 : 15);
    fill('mp', cap > 0 ? 100 - (spent / cap) * 100 : 0);
    set('[data-made]', String(s.made));
    set('[data-posted]', String(s.posted));
    set('[data-next]', s.next ? hhmm(s.next.at) + 'Z, ' + s.next.platform : 'none planned');
    set('[data-products]', s.products.on + ' of ' + s.products.total);
    const q = document.querySelector('[data-quests]');
    if (q) q.replaceChildren(...s.quests.map((x) => { const li = el('li', x.urgent ? 'urgent' : null); const a = el('a', null, x.text); a.href = x.href; li.append(a); return li; }));
    const c = document.querySelector('[data-chat]');
    if (c) c.replaceChildren(...(s.chat.length ? s.chat.map((m) => { const li = el('li', 'c-' + m.kind); li.append(el('time', null, hhmm(m.ts)), document.createTextNode(' '), el('b', null, '[' + m.who + ']'), document.createTextNode(' ' + m.text)); return li; }) : [el('li', 'muted', 'All quiet in town.')]));
  }
  let timer = null;
  async function poll() {
    try {
      const r = await fetch('/town.json', { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { accept: 'application/json' } });
      if (r.type === 'opaqueredirect' || r.status === 303 || r.status === 401 || r.status === 403) { clearInterval(timer); return; }
      if (!r.ok) return;
      state = await r.json();
      hud(state);
    } catch { /* the next poll tries again */ }
  }
  if (state) hud(state);
  timer = setInterval(() => { if (!document.hidden) poll(); }, 15000);

  let prev = 0;
  function frame(ts) {
    dt = prev ? Math.min(0.1, (ts - prev) / 1000) : 0;
    prev = ts;
    update();
    draw();
    requestAnimationFrame(frame);
  }
  // Coming back with the browser's Back button shows the town again, not the fade.
  addEventListener('pageshow', () => { entering = null; keys.clear(); });
  requestAnimationFrame(frame);
})();
