'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ageText,
  quotaLevel,
  resetText,
  serviceState,
} = require('../dashboard');

test('expired reset timestamps are not projected into a future cycle', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  assert.equal(resetText(now - 60_000, now), 'expired');
  assert.equal(resetText(now + 90 * 60_000, now), '1h 30m');
});

test('the configured alert threshold controls the alert state', () => {
  assert.equal(quotaLevel(39, 40), 'normal');
  assert.equal(quotaLevel(40, 40), 'alert');
  assert.equal(quotaLevel(70, 85), 'warning');
  assert.equal(quotaLevel(85, 85), 'alert');
});

test('service freshness remains visible in the rendered state model', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  const stale = serviceState({ five: { used: 10 }, stale: true, fetchedAt: now - 3600_000 }, now);
  assert.deepEqual(stale, { label: 'stale 1h', kind: 'stale' });

  const offline = serviceState({ five: { used: 10 }, stale: true, fetchedAt: now, error: 'offline' }, now);
  assert.deepEqual(offline, { label: 'offline now', kind: 'error' });
  assert.equal(ageText(null, now), 'unknown age');
});
