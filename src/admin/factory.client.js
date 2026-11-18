// The Factory page's only script, served at /factory.js. It reads /factory.json every few seconds and moves
// each crate (slot) to its station. It never writes, builds every node with createElement and textContent, and only fetches this origin.
'use strict';
(() => {
  const floor = document.getElementById('factory');
  if (!floor) return;

  const STAGES = ['dock', 'design', 'foundry', 'inspect', 'paint', 'label', 'gate', 'shipping'];
  const NAMES = { dock: 'Loading dock', design: 'Concept studio', foundry: 'Clip foundry', inspect: 'Inspection', paint: 'Caption shop', label: 'Label press', gate: 'Approval gate', shipping: 'Shipping docks', shipped: 'Shipped', scrap: 'Scrap bin' };
  const DOING = {
    dock: 'Planned. The producer picks it up on a tick, a manual post first.',
    design: 'The brief is read from Shopify, the concept writer drafts the scene and the claim judge checks every statement.',
    foundry: 'One paid Higgsfield job renders the 15 second clip, or a stored clip is pulled for reuse.',
    inspect: 'A model looks at eight frames against the product photos and the owner\'s note.',
    paint: 'Remotion draws the caption, mixes the music, normalizes loudness and runs the ten-check QA gate.',
    label: 'The copy writer writes titles, captions and hashtags for each platform, and the copy judge checks them.',
    gate: 'A manual post waits here until the owner presses Post or Discard on the Posts page.',
    shipping: 'Each platform is posted through the bridge at its scheduled time.',
    shipped: 'Every platform is done.',
    scrap: 'The slot failed or was discarded. Nothing was published.',
  };
  const DECOR = [['bp', 2], ['film', 3], ['ok', 4], ['paint', 5], ['tag', 6]];
  const PL = ['youtube', 'facebook', 'instagram', 'tiktok'];
  const MAX_SCRAP = 10;

  const items = floor.querySelector('[data-items]');
  const belt = floor.querySelector('.belt');
  const bin = floor.querySelector('[data-scrap]');
  const board = document.querySelector('[data-board]');
  const insp = document.querySelector('[data-inspector]');
  const hb = document.querySelector('[data-hb]');
  const updated = document.querySelector('[data-updated]');
  const demo = floor.dataset.demo === '1';

  const crates = new Map(); // slot id -> { el, stage, lvl, slot, leaving }
  let selected = null;
  let last = null;
  let prevPublished = null;
  let first = true;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };
  const station = (k) => floor.querySelector('[data-station="' + k + '"]');
  const rel = (e) => {
    const f = floor.getBoundingClientRect();
    const r = e.getBoundingClientRect();
    return { x: r.left - f.left, y: r.top - f.top, w: r.width, h: r.height };
  };
  const shortId = (id) => {
    const i = id.indexOf('#');
    return i < 0 ? id.slice(-4) : '#' + id.slice(i + 1);
  };
  const setPos = (e, p) => {
    e.style.setProperty('--x', p.x.toFixed(1) + 'px');
    e.style.setProperty('--y', p.y.toFixed(1) + 'px');
    e.style.setProperty('--r', (p.r || 0) + 'deg');
  };

  function makeCrate(s) {
    const b = el('button', 'crate');
    b.type = 'button';
    b.append(el('span', 'c-tape'), el('span', 'c-id', shortId(s.id)));
    for (const [d] of DECOR) b.append(el('span', 'd d-' + d));
    b.addEventListener('click', () => {
      selected = selected === s.id ? null : s.id;
      showInspector();
      for (const [id, c] of crates) c.el.classList.toggle('sel', id === selected);
    });
    items.append(b);
    return b;
  }

  // Target position of every crate, relative to the floor.
  function place(list) {
    const groups = {};
    for (const s of list) (groups[s.stage] = groups[s.stage] || []).push(s);
    const top = belt.offsetTop - 34;
    const pos = new Map();
    for (const stage of Object.keys(groups)) {
      const g = groups[stage];
      if (stage === 'shipped') {
        const r = rel(station('shipping'));
        g.forEach((s, i) => pos.set(s.id, { x: r.x + r.w + 80 + i * 12, y: top, r: 0 }));
      } else if (stage === 'scrap') {
        const b = rel(bin);
        g.forEach((s, i) => pos.set(s.id, { x: b.x + 14 + (i % 5) * 18, y: b.y + 2 - Math.floor(i / 5) * 8, r: [-14, 9, -5, 16, -9][i % 5] }));
      } else {
        const st = station(stage);
        if (!st) continue;
        const r = rel(st);
        const cx = stage === 'shipping' ? r.x + 46 : r.x + r.w / 2;
        const n = g.length;
        const gap = n > 1 ? Math.min(46, (r.w - 44) / (n - 1)) : 0;
        g.forEach((s, i) => pos.set(s.id, { x: cx - 20 + (i - (n - 1) / 2) * gap, y: top, r: 0 }));
      }
    }
    return pos;
  }

  function flash(stage) {
    const st = station(stage);
    if (!st) return;
    st.classList.remove('flash');
    void st.offsetWidth;
    st.classList.add('flash');
  }

  function decorate(c, s) {
    const i = STAGES.indexOf(s.stage);
    if (i >= 0) c.lvl = i;
    else if (s.stage === 'shipped') c.lvl = 8;
    const e = c.el;
    for (const [d, at] of DECOR) e.classList.toggle('has-' + d, c.lvl >= at);
    e.classList.toggle('k-manual', s.kind === 'manual');
    e.classList.toggle('scrapped', s.stage === 'scrap');
    e.classList.toggle('working', i >= 1 && i <= 5);
    e.classList.toggle('sel', s.id === selected);
    e.setAttribute('aria-label', 'Slot ' + s.id + ', ' + NAMES[s.stage]);
    e.title = s.id + ': ' + NAMES[s.stage];
  }

  function render(state) {
    last = state;
    const scrap = state.slots.filter((s) => s.stage === 'scrap').slice(-MAX_SCRAP);
    const list = state.slots.filter((s) => (s.stage === 'shipped' ? crates.has(s.id) : s.stage !== 'scrap')).concat(scrap);
    const pos = place(list);
    const seen = new Set();
    for (const s of list) {
      const p = pos.get(s.id);
      if (!p) continue;
      seen.add(s.id);
      let c = crates.get(s.id);
      if (!c) {
        c = { el: makeCrate(s), stage: null, lvl: 0, leaving: false };
        crates.set(s.id, c);
        c.el.classList.add('no-t');
        if (!first && s.stage === 'dock') setPos(c.el, { x: -60, y: p.y, r: 0 });
        else setPos(c.el, p);
        void c.el.offsetWidth;
        c.el.classList.remove('no-t');
      }
      if (c.stage !== s.stage) {
        if (c.stage !== null) {
          c.el.classList.add('moving');
          setTimeout(() => c.el.classList.remove('moving'), 2400);
          flash(s.stage);
        }
        c.stage = s.stage;
      }
      c.slot = s;
      setPos(c.el, p);
      decorate(c, s);
      if (s.stage === 'shipped' && !c.leaving) {
        c.leaving = true;
        setTimeout(() => c.el.classList.add('gone'), 1600);
        setTimeout(() => {
          c.el.remove();
          crates.delete(s.id);
        }, 2600);
      }
    }
    for (const [id, c] of crates) {
      if (seen.has(id) || c.leaving) continue;
      c.leaving = true;
      c.el.classList.add('gone');
      setTimeout(() => {
        c.el.remove();
        crates.delete(id);
      }, 700);
    }
    stations(state);
    trucks(state);
    boardRows(state);
    hud(state);
    if (selected) showInspector();
    first = false;
  }

  function stations(state) {
    const n = {};
    for (const s of state.slots) n[s.stage] = (n[s.stage] || 0) + 1;
    const uploading = PL.some((p) => state.uploading[p] > 0);
    for (const k of STAGES) {
      const st = station(k);
      const c = n[k] || 0;
      st.classList.toggle('busy', c > 0 || (k === 'shipping' && uploading));
      st.classList.toggle('waiting', k === 'gate' && c > 0);
      const b = st.querySelector('[data-count]');
      if (b) b.textContent = String(c);
    }
    const sn = floor.querySelector('[data-scrapn]');
    if (sn) sn.textContent = String(state.scrapped);
  }

  function trucks(state) {
    const waiting = {};
    for (const s of state.slots) if (s.stage === 'shipping') for (const p of s.pubs) if (p.s === 'pending' || p.s === 'uploading') waiting[p.p] = true;
    for (const p of PL) {
      const t = floor.querySelector('.truck[data-p="' + p + '"]');
      if (!t) continue;
      const n = t.querySelector('[data-n]');
      if (n) n.textContent = String(state.published[p] || 0);
      t.classList.toggle('loading', state.uploading[p] > 0 || !!waiting[p]);
      if (prevPublished && (state.published[p] || 0) > (prevPublished[p] || 0)) {
        t.classList.remove('depart');
        void t.getBoundingClientRect();
        t.classList.add('depart');
        setTimeout(() => t.classList.remove('depart'), 2700);
      }
    }
    prevPublished = Object.assign({}, state.published);
  }

  function boardRows(state) {
    if (!board) return;
    const rows = state.slots.filter((s) => s.stage !== 'shipped' && s.stage !== 'scrap');
    const out = [];
    for (const s of rows) {
      const tr = el('tr');
      tr.append(el('td', 'nw', s.id), el('td', null, s.kind), el('td', null, NAMES[s.stage]), el('td', null, s.caption), el('td', null, s.pubs.map((p) => p.p + ': ' + p.s).join(', ')));
      out.push(tr);
    }
    if (!out.length) {
      const tr = el('tr');
      const td = el('td', 'muted', 'The line is empty. Nothing is planned or in production.');
      td.colSpan = 5;
      tr.append(td);
      out.push(tr);
    }
    board.replaceChildren(...out);
  }

  function hud(state) {
    if (hb) {
      const a = state.heartbeatAge;
      hb.textContent = a === null ? 'Pipeline never ticked' : a > 300 ? 'Pipeline stale (' + a + ' s)' : 'Pipeline alive (' + a + ' s ago)';
      hb.classList.toggle('ok', a !== null && a <= 300);
      hb.classList.toggle('bad', a === null || a > 300);
    }
    if (updated) updated.textContent = 'Updated ' + state.now.slice(11, 19) + 'Z';
    floor.classList.toggle('dry', !!state.dryRun);
  }

  function showInspector() {
    if (!insp) return;
    const c = selected ? crates.get(selected) : null;
    const s = c ? c.slot : null;
    if (!s) {
      insp.replaceChildren(el('p', 'muted', 'Select a crate on the belt to see where it is and what happens next.'));
      return;
    }
    const dl = el('dl', 'insp-grid');
    const row = (k, v) => {
      if (v === null || v === undefined || v === '') return;
      dl.append(el('dt', null, k));
      const dd = el('dd');
      if (v instanceof Node) dd.append(v);
      else dd.textContent = String(v);
      dl.append(dd);
    };
    row('Station', NAMES[s.stage]);
    row('Happening', DOING[s.stage]);
    row('Kind', s.kind === 'manual' ? 'manual (Post button)' : 'planned');
    row('Tier', s.tier);
    row('Attempt', s.attempt);
    row('Hold', s.hold);
    row('Caption', s.caption);
    row('Error', s.error);
    if (s.pubs.length) {
      const span = el('span');
      for (const p of s.pubs) span.append(el('span', 'chip ' + p.s, p.p + ': ' + p.s.replace('_', ' ')));
      row('Platforms', span);
    }
    const close = el('button', null, 'Close');
    close.type = 'button';
    close.addEventListener('click', () => {
      selected = null;
      showInspector();
      for (const x of crates.values()) x.el.classList.remove('sel');
    });
    insp.replaceChildren(el('h3', null, 'Crate ' + s.id), dl, close);
  }

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
      render(await r.json());
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
      slots.push({ id: 'demo#' + seq, kind: seq % 4 === 0 ? 'manual' : 'planned', stage: 'dock', caption: CAPS[seq % CAPS.length], tier: 't2', attempt: 0, hold: null, error: null, pubs: PL.map((p) => ({ p, s: 'pending' })), wait: 0, age: 0 });
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
        slots: slots.map((s) => ({ id: s.id, kind: s.kind, stage: s.stage, caption: s.caption, tier: s.tier, attempt: s.attempt, hold: s.hold, error: s.error, pubs: s.pubs.map((p) => ({ p: p.p, s: p.s })) })),
        published: Object.assign({}, published),
        uploading,
        scrapped,
      };
    };
  }

  // Re-place crates without sliding them when the floor changes size.
  let resizeT = null;
  addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!last) return;
      for (const c of crates.values()) c.el.classList.add('no-t');
      render(last);
      void floor.offsetWidth;
      for (const c of crates.values()) c.el.classList.remove('no-t');
    }, 150);
  });

  if (demo) {
    const step = demoShift();
    render(step());
    timer = setInterval(() => render(step()), 2300);
  } else {
    try {
      render(JSON.parse(floor.dataset.state || 'null'));
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
})();
