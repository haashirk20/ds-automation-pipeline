import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errSummary, fmtDate, fmtLocal, flash } from '../src/admin/ui.ts';

test('fmtLocal shows shop-local time across a daylight saving change', () => {
  // Toronto leaves daylight time on 2026-11-01 at 02:00 local.
  assert.equal(fmtLocal('2026-10-31T16:15:00Z', 'America/Toronto'), 'Sat 31 Oct, 12:15');
  assert.equal(fmtLocal('2026-11-02T17:15:00Z', 'America/Toronto'), 'Mon 2 Nov, 12:15');
  assert.equal(fmtLocal('2026-11-12T23:59:00Z', 'America/Toronto'), 'Thu 12 Nov, 18:59');
  assert.equal(fmtLocal(null, 'UTC'), '');
  assert.equal(fmtLocal('t', 'UTC'), '');
  assert.equal(fmtDate('2026-11-20'), 'Fri 20 Nov');
});

test('errSummary and flash escape their text; only ok and info are a status', () => {
  const s = errSummary([{ id: 'f-x', label: 'A <b>', msg: '<script>x</script>' }, { msg: 'plain' }]).toString();
  assert.match(s, /role="alert"/);
  assert.match(s, /Fix 2 things/);
  assert.ok(s.includes('href="#f-x"') && s.includes('A &lt;b&gt;: &lt;script&gt;x&lt;/script&gt;') && !s.includes('<script'));
  assert.equal(errSummary([]), '');
  assert.match(flash('ok', 'Saved.').toString(), /role="status"/);
  assert.match(flash('bad', '<i>').toString(), /role="alert"[\s\S]*&lt;i&gt;/);
});
