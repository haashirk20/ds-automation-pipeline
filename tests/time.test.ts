import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateOf, localToUtc } from '../src/scheduler/time.ts';

const tz = 'America/Toronto';
const iso = (d: string, t: string) => localToUtc(d, t, tz).toISOString();

test('normal winter and summer offsets', () => {
  assert.equal(iso('2026-11-12', '12:15'), '2026-11-12T17:15:00.000Z');
  assert.equal(iso('2026-07-01', '12:15'), '2026-07-01T16:15:00.000Z');
});

test('spring forward 2027-03-14: nonexistent 02:30 resolves forward', () => {
  assert.equal(iso('2027-03-14', '01:30'), '2027-03-14T06:30:00.000Z');
  assert.equal(iso('2027-03-14', '02:30'), '2027-03-14T07:30:00.000Z'); // 03:30 EDT
  assert.equal(iso('2027-03-14', '12:15'), '2027-03-14T16:15:00.000Z');
});

test('fall back 2027-11-07: ambiguous 01:30 is the first occurrence', () => {
  assert.equal(iso('2027-11-07', '01:30'), '2027-11-07T05:30:00.000Z'); // EDT
  assert.equal(iso('2027-11-07', '12:15'), '2027-11-07T17:15:00.000Z');
});

test('localDateOf', () => {
  assert.equal(localDateOf(new Date('2026-11-12T01:30:00Z'), tz), '2026-11-11');
  assert.equal(localDateOf(new Date('2026-11-12T05:00:00Z'), tz), '2026-11-12');
});
