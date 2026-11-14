import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInTz, parseWhen } from '../src/utils/time.js';

const TZ = 'Asia/Tashkent'; // UTC+5
const now = new Date('2026-11-13T10:00:00Z'); // 15:00 in Tashkent

test('parseWhen: relative inputs', () => {
  assert.equal(parseWhen('+10m', now, TZ)?.toISOString(), '2026-11-13T10:10:00.000Z');
  assert.equal(parseWhen('2h', now, TZ)?.toISOString(), '2026-11-13T12:00:00.000Z');
  assert.equal(parseWhen('30 daqiqa', now, TZ)?.toISOString(), '2026-11-13T10:30:00.000Z');
  assert.equal(parseWhen('1 kun', now, TZ)?.toISOString(), '2026-11-14T10:00:00.000Z');
});

test('parseWhen: HH:MM today or tomorrow in local time zone', () => {
  assert.equal(parseWhen('18:30', now, TZ)?.toISOString(), '2026-11-13T13:30:00.000Z');
  assert.equal(parseWhen('09:00', now, TZ)?.toISOString(), '2026-11-14T04:00:00.000Z');
});

test('parseWhen: absolute dates', () => {
  assert.equal(parseWhen('2026-11-20 09:00', now, TZ)?.toISOString(), '2026-11-20T04:00:00.000Z');
  assert.equal(parseWhen('20.11.2026 09:00', now, TZ)?.toISOString(), '2026-11-20T04:00:00.000Z');
});

test('parseWhen: garbage returns null', () => {
  for (const s of ['ertaga', '25:00', '2026-13-01 10:00', '', '+0m']) assert.equal(parseWhen(s, now, TZ), null, s);
});

test('formatInTz renders local time', () => {
  assert.match(formatInTz(now, TZ), /13\.11\.2026.*15:00/);
});
