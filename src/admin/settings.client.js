// The settings pages' only script, served at /settings.js. It turns the settings form into blocks on a factory
// line and plays the shipping animation when a new version is saved. It changes how the form looks, never what
// it sends: every block's inputs stay inside the same form. It builds nodes with createElement and textContent
// only, and makes no requests of its own. Without it the plain form works the same.
'use strict';
(() => {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };
  const PL = ['youtube', 'facebook', 'instagram', 'tiktok'];
  const PNAME = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };
  const PSHORT = { youtube: 'YT', facebook: 'FB', instagram: 'IG', tiktok: 'TT' };

  // ---------- the block editor on /settings ----------
  const form = document.querySelector('form[data-blocks]');
  if (form) blocks(form);

  function blocks(form) {
    const META = {
      schedule: ['Clock tower', 'When videos are made and posted'],
      concept: ['Concept studio', 'Who writes each scene'],
      claims: ['Claim checker', 'Who checks every statement'],
      clips: ['Clip foundry', 'Which video model, and what it may spend'],
      inspect: ['Inspection', 'Who checks the frames'],
      music: ['Music room', 'How loud the music plays'],
      platforms: ['Shipping docks', 'Where videos are posted'],
      budget: ['Budget office', 'Monthly caps and the Post-button limit'],
      ops: ['Maintenance', 'Clean-up and disk alerts'],
    };
    const LINE = ['schedule', 'concept', 'claims', 'clips', 'inspect', 'music', 'platforms'];
    const OFFICE = ['budget', 'ops'];
    const sets = {};
    for (const fs of form.querySelectorAll('fieldset[data-block]')) sets[fs.dataset.block] = fs;
    if (!sets.platforms) return;

    const field = (name) => form.elements.namedItem(name);
    const val = (name) => {
      const e = field(name);
      if (!e) return '';
      return e.type === 'checkbox' ? e.checked : e.value;
    };
    const optText = (name) => {
      const e = field(name);
      return e && e.selectedOptions && e.selectedOptions[0] ? e.selectedOptions[0].textContent : val(name);
    };
    const enabled = () => PL.filter((p) => val('platforms.' + p + '.enabled') === true);
    const SUM = {
      schedule: () => {
        const on = enabled();
        const n = on.length ? String(val('platforms.' + on[0] + '.slots')).split(/[\s,]+/).filter(Boolean).length : 0;
        return ['Makes videos at ' + val('produceAt'), on.length ? n + ' post' + (n === 1 ? '' : 's') + ' a day on each platform' : 'No platform is on'];
      },
      concept: () => ['Writer: ' + val('llm.models.script'), 'Reuses a clip after ' + val('ugc.reuseAfterDays') + ' days'],
      claims: () => ['Judge: ' + val('llm.models.copy')],
      clips: () => ['Model: ' + optText('tiers.t2Preset'), 'Up to $' + val('tiers.capsUsd.t2') + ' a month'],
      inspect: () => ['Checker: ' + val('llm.models.qa')],
      music: () => ['Music at ' + val('ugc.music.volumeDb') + ' dB', 'Dips ' + val('ugc.music.duckDb') + ' dB under speech'],
      platforms: () => {
        const on = enabled();
        return on.length ? [on.map((p) => PNAME[p] + (val('platforms.' + p + '.visibility') === 'private' ? ' (private)' : '')).join(', ')] : ['Nothing connected: the factory pauses'];
      },
      budget: () => ['Writers up to $' + val('llm.monthlyCapUsd') + ' a month', val('approval.manualPerDay') + ' Post-button videos a day'],
      ops: () => ['Keeps files ' + val('ops.keepDays') + ' days', 'Disk alert at ' + val('ops.diskAlertPercent') + '%'],
    };

    // What each input held when the page loaded, to mark edited blocks and count changes.
    const start = new Map();
    const inputs = () => [...form.elements].filter((e) => e.name && e.type !== 'hidden' && e.type !== 'submit' && e.type !== 'button');
    for (const e of inputs()) start.set(e, e.type === 'checkbox' ? e.checked : e.value);
    const changed = (e) => start.has(e) && (e.type === 'checkbox' ? e.checked : e.value) !== start.get(e);

    // Layout: intro, line, office, parts box, sticky bar.
    const plain = document.querySelector('.bl-plain');
    const wrap = el('div', 'bl');
    wrap.append(el('p', 'bl-help', 'Each block is one part of the factory. Click a block to change it. Drag a platform truck from the parts box onto the shipping docks to switch it on, or back to the box to switch it off.'));
    const line = el('div', 'bl-line');
    const office = el('div', 'bl-line bl-office');
    const tray = el('div', 'bl-tray');
    const trayHead = el('div', 'bl-tray-h', 'Parts box');
    const trayParts = el('div', 'bl-tray-parts');
    tray.append(trayHead, trayParts);
    const lineHead = el('h2', null, 'The production line');
    const officeHead = el('h2', null, 'The office');
    wrap.append(lineHead, line, tray, officeHead, office);
    form.prepend(wrap);
    if (plain) plain.hidden = true;

    const tiles = {};
    const dialogs = {};
    const sockets = el('div', 'bl-sockets');

    function makeTile(id, i, host) {
      const t = el('button', 'bl-tile bl-' + id);
      t.type = 'button';
      const num = el('span', 'bl-num', String(i + 1));
      const icon = el('span', 'bl-icon bl-i-' + id);
      icon.setAttribute('aria-hidden', 'true');
      const name = el('span', 'bl-name', META[id][0]);
      const what = el('span', 'bl-what', META[id][1]);
      const sum = el('span', 'bl-sum');
      const flag = el('span', 'bl-flag');
      t.append(num, icon, name, what, sum, flag);
      if (id === 'platforms') t.append(sockets);
      t.addEventListener('click', (ev) => {
        if (ev.target.closest && ev.target.closest('.bl-part')) return;
        open(id);
      });
      host.append(t);
      if (host === line && i < LINE.length - 1) {
        const belt = el('span', 'bl-belt');
        belt.setAttribute('aria-hidden', 'true');
        host.append(belt);
      }
      tiles[id] = { t, sum, flag };
      // The block's own inputs go into a dialog inside the form, so they are still submitted.
      const d = el('dialog', 'bl-dialog');
      const head = el('div', 'bl-dh');
      const di = el('span', 'bl-icon bl-i-' + id);
      di.setAttribute('aria-hidden', 'true');
      const dt = el('div');
      dt.append(el('strong', null, META[id][0]), el('span', null, META[id][1]));
      const done = el('button', 'primary', 'Done');
      done.type = 'button';
      done.addEventListener('click', () => d.close());
      head.append(di, dt, done);
      d.append(head, sets[id]);
      d.addEventListener('close', refresh);
      d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
      form.append(d);
      dialogs[id] = d;
    }
    LINE.forEach((id, i) => sets[id] && makeTile(id, i, line));
    OFFICE.forEach((id, i) => sets[id] && makeTile(id, LINE.length + i, office));

    function open(id) {
      const d = dialogs[id];
      if (!d) return;
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      const first = d.querySelector('input:not([type=hidden]),select,textarea');
      if (first) first.focus();
    }

    // Platform parts: a truck per platform, plugged into the docks or lying in the parts box.
    const parts = {};
    for (const p of PL) {
      const box = field('platforms.' + p + '.enabled');
      if (!box) continue;
      const b = el('button', 'bl-part bl-p-' + p);
      b.type = 'button';
      b.dataset.p = p;
      b.append(el('span', 'bl-truck', PSHORT[p]), el('span', 'bl-pl', PNAME[p]));
      let dragged = false;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (dragged) { dragged = false; return; }
        toggle(p, !box.checked); // keyboard, or a tap without moving
      });
      // Pointer dragging works with a mouse, a finger or a pen. A ghost follows the pointer; dropping on the
      // docks switches the platform on, dropping on the parts box switches it off.
      b.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        const x0 = ev.clientX, y0 = ev.clientY;
        let ghost = null;
        let over = null;
        const zoneAt = (x, y) => {
          const t = document.elementFromPoint(x, y);
          return t ? t.closest('.bl-platforms, .bl-tray') : null;
        };
        const move = (e) => {
          if (!ghost && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
          if (!ghost) {
            ghost = b.cloneNode(true);
            ghost.classList.add('bl-ghost');
            ghost.setAttribute('aria-hidden', 'true');
            document.body.append(ghost);
            b.classList.add('dragging');
          }
          ghost.style.setProperty('left', e.clientX - 20 + 'px');
          ghost.style.setProperty('top', e.clientY - 16 + 'px');
          ghost.hidden = true;
          const z = zoneAt(e.clientX, e.clientY);
          ghost.hidden = false;
          if (z !== over) {
            if (over) over.classList.remove('over');
            over = z;
            if (over) over.classList.add('over');
          }
          e.preventDefault();
        };
        const up = (e) => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          removeEventListener('pointercancel', up);
          if (!ghost) return;
          dragged = true;
          ghost.remove();
          b.classList.remove('dragging');
          if (over) over.classList.remove('over');
          if (e.type === 'pointerup' && over) toggle(p, over.classList.contains('bl-platforms'));
          setTimeout(() => { dragged = false; }, 0);
        };
        addEventListener('pointermove', move, { passive: false });
        addEventListener('pointerup', up);
        addEventListener('pointercancel', up);
      });
      parts[p] = { b, box };
    }
    function toggle(p, on) {
      const x = parts[p];
      if (!x || x.box.checked === on) return;
      x.box.checked = on;
      x.box.dispatchEvent(new Event('change', { bubbles: true }));
      x.b.classList.remove('snap');
      void x.b.offsetWidth;
      x.b.classList.add('snap');
      refresh();
    }

    // The bar that stays at the bottom: how many changes are packed, undo, and review.
    const bar = el('div', 'bl-bar');
    const count = el('span', 'bl-count');
    const undo = el('button', null, 'Undo all');
    undo.type = 'button';
    undo.addEventListener('click', () => {
      for (const [e, v] of start) {
        if (e.type === 'checkbox') e.checked = v;
        else e.value = v;
      }
      refresh();
    });
    const go = el('button', 'primary', 'Pack and review');
    go.type = 'submit';
    bar.append(count, undo, go);
    const actions = form.querySelector(':scope > .actions');
    if (actions) actions.replaceWith(bar);
    else form.append(bar);

    function refresh() {
      let n = 0;
      for (const id of Object.keys(tiles)) {
        const fs = sets[id];
        const edited = [...fs.querySelectorAll('input,select,textarea')].filter(changed).length;
        n += edited;
        const { t, sum, flag } = tiles[id];
        sum.replaceChildren(...SUM[id]().map((s) => el('span', null, s)));
        t.classList.toggle('edited', edited > 0);
        t.classList.toggle('error', fs.dataset.error === '1');
        flag.textContent = fs.dataset.error === '1' ? 'Fix me' : edited ? edited + ' changed' : '';
        t.setAttribute('aria-label', META[id][0] + '. ' + SUM[id]().join('. ') + (edited ? '. ' + edited + ' changed.' : '') + ' Open to change.');
      }
      for (const p of PL) {
        const x = parts[p];
        if (!x) continue;
        (x.box.checked ? sockets : trayParts).append(x.b);
        x.b.setAttribute('aria-pressed', x.box.checked ? 'true' : 'false');
        x.b.title = x.box.checked ? PNAME[p] + ' is on. Click or drag to the parts box to switch it off.' : PNAME[p] + ' is off. Click or drag onto the shipping docks to switch it on.';
      }
      trayParts.dataset.empty = trayParts.children.length ? '' : 'All platforms are connected.';
      count.textContent = n ? n + ' change' + (n === 1 ? '' : 's') + ' ready to pack' : 'No changes yet';
      go.disabled = n === 0;
      bar.classList.toggle('ready', n > 0);
    }
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    refresh();
    // A form sent back with errors opens the first block that needs fixing.
    const bad = Object.keys(tiles).find((id) => sets[id].dataset.error === '1');
    if (bad) open(bad);
  }

  // ---------- the shipping animation on the review page ----------
  const ship = document.querySelector('form[data-ship]');
  if (ship) {
    ship.addEventListener('submit', (ev) => {
      if (ship.dataset.go === '1') return;
      const cp = ship.querySelector('[name="confirm_public"]');
      if (cp && !cp.checked) return; // the server explains what is missing
      ev.preventDefault();
      const btn = ship.querySelector('button[type="submit"]');
      play(btn ? btn.dataset.version : '', () => {
        ship.dataset.go = '1';
        ship.submit();
      });
    });
  }

  function play(version, done) {
    const labels = [...document.querySelectorAll('[data-changes] tr[data-label]')].map((r) => r.dataset.label).slice(0, 6);
    const stage = el('div', 'ship');
    stage.setAttribute('role', 'status');
    const scene = el('div', 'ship-scene');
    const sky = el('div', 'ship-items');
    labels.forEach((l, i) => {
      const b = el('span', 'ship-item', l);
      b.style.setProperty('--i', String(i));
      b.style.setProperty('--x', String((i % 3) - 1));
      sky.append(b);
    });
    const crate = el('div', 'ship-crate');
    const lid = el('span', 'ship-lid');
    const tag = el('span', 'ship-tag', version ? 'V' + version : 'NEW');
    crate.append(lid, el('span', 'ship-box'), tag);
    const belt = el('div', 'ship-belt');
    const house = el('div', 'ship-house');
    const door = el('span', 'ship-door');
    const chimney = el('span', 'ship-chimney');
    house.append(chimney, el('span', 'ship-roof'), door, el('span', 'ship-sign', 'FACTORY'));
    const say = el('p', 'ship-say', 'Packing ' + labels.length + ' setting' + (labels.length === 1 ? '' : 's') + '…');
    const skip = el('button', null, 'Skip');
    skip.type = 'button';
    scene.append(sky, belt, crate, house);
    stage.append(scene, say, skip);
    document.body.append(stage);
    const t = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      t.forEach(clearTimeout);
      done();
    };
    skip.addEventListener('click', finish);
    const fall = 450 + labels.length * 260;
    requestAnimationFrame(() => stage.classList.add('on'));
    t.push(setTimeout(() => { stage.classList.add('closed'); say.textContent = 'Sealed and labelled.'; }, fall));
    t.push(setTimeout(() => { stage.classList.add('go'); say.textContent = 'On its way to the factory…'; }, fall + 600));
    t.push(setTimeout(() => { stage.classList.add('in'); say.textContent = 'Delivered! The factory uses it from the next tick.'; }, fall + 2200));
    t.push(setTimeout(finish, fall + 3100));
  }
})();
