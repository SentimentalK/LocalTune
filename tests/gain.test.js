import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGainDb, gainFactor, parseItunNorm, decideGain } from '../src/core/gain.js';

test('parseGainDb reads signed values with and without the dB suffix', () => {
  assert.equal(parseGainDb('-7.25 dB'), -7.25);
  assert.equal(parseGainDb('+3.0 dB'), 3);
  assert.equal(parseGainDb('-7.25'), -7.25);
  assert.equal(parseGainDb('7.2 db'), 7.2);
  assert.equal(parseGainDb('  -1.5   DB '), -1.5);
});

test('parseGainDb rejects empty, malformed and non-string values', () => {
  assert.equal(parseGainDb(''), null);
  assert.equal(parseGainDb('   '), null);
  assert.equal(parseGainDb('loud'), null);
  assert.equal(parseGainDb('dB'), null);
  assert.equal(parseGainDb('1.2.3 dB'), null);
  assert.equal(parseGainDb('-7 dB extra'), null);
  assert.equal(parseGainDb(undefined), null);
  assert.equal(parseGainDb(null), null);
  assert.equal(parseGainDb(-7.25), null);
});

test('parseGainDb clamps to plus or minus 24 dB', () => {
  assert.equal(parseGainDb('-30 dB'), -24);
  assert.equal(parseGainDb('+40 dB'), 24);
  assert.equal(parseGainDb('-24'), -24);
  assert.equal(parseGainDb('24.01'), 24);
});

test('gainFactor converts decibels to a clamped linear factor', () => {
  assert.equal(gainFactor(0), 1);
  assert.ok(Math.abs(gainFactor(-6) - 0.5011) < 0.001);
  assert.ok(Math.abs(gainFactor(6) - 1.9952) < 0.001);
  assert.equal(gainFactor(-100), 0.1);
  assert.equal(gainFactor(100), 4);
  assert.equal(gainFactor(Infinity), 1);
  assert.equal(gainFactor(NaN), 1);
});

test('parseItunNorm decodes eight digit hex words', () => {
  const parsed = parseItunNorm(' 0000012C 0000012C 0000B5C8 0000B5C8 0000012C 0000012C ');
  assert.deepEqual(parsed, [0x12c, 0x12c, 0xb5c8, 0xb5c8, 0x12c, 0x12c]);
  assert.deepEqual(parseItunNorm('00000001 00000002 00000003 00000004'), [1, 2, 3, 4]);
});

test('parseItunNorm rejects short and non-hex payloads', () => {
  assert.equal(parseItunNorm(''), null);
  assert.equal(parseItunNorm('00000001 00000002 00000003'), null, 'fewer than four words');
  assert.equal(parseItunNorm('00000001 00000002 00000003 zzzzzzzz'), null);
  assert.equal(parseItunNorm('00000001 00000002 00000003 0000000'), null, 'short word');
  assert.equal(parseItunNorm(null), null);
});

test('decideGain reports off when leveling is disabled', () => {
  assert.deepEqual(decideGain({ trackGainDb: -6 }), { db: null, factor: 1, reason: 'off' });
  assert.deepEqual(decideGain({ trackGainDb: -6 }, { enabled: false }), {
    db: null,
    factor: 1,
    reason: 'off',
  });
});

test('decideGain reports none for tags without a usable track gain', () => {
  assert.deepEqual(decideGain(null, { enabled: true }), { db: null, factor: 1, reason: 'none' });
  assert.deepEqual(decideGain({}, { enabled: true }), { db: null, factor: 1, reason: 'none' });
  assert.deepEqual(decideGain({ trackGainDb: null }, { enabled: true }), {
    db: null,
    factor: 1,
    reason: 'none',
  });
});

test('decideGain applies the tag gain when leveling is enabled', () => {
  const decision = decideGain({ trackGainDb: -6 }, { enabled: true });
  assert.equal(decision.reason, 'tag');
  assert.equal(decision.db, -6);
  assert.ok(Math.abs(decision.factor - 0.5011) < 0.001);
});
