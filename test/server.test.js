'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  createDashboardServer,
  readLatestCodexSnapshot,
  requestHostName,
} = require('../server');

function tokenCountEvent(timestamp, primary = 12, secondary = 34) {
  return JSON.stringify({
    timestamp,
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: primary },
        secondary: { used_percent: secondary },
      },
    },
  });
}

test('Codex snapshots are read backwards without loading an oversized trailing line', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-codex-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'rollout-test.jsonl');
  const expectedTimestamp = '2026-07-10T10:00:00.000Z';
  fs.writeFileSync(
    filePath,
    tokenCountEvent(expectedTimestamp, 23, 45) + '\n' + 'x'.repeat(3 * 1024 * 1024),
    'utf8',
  );

  const snapshot = readLatestCodexSnapshot(filePath);
  assert.equal(snapshot.timestamp, Date.parse(expectedTimestamp));
  assert.equal(snapshot.rateLimits.primary.used_percent, 23);
  assert.equal(snapshot.rateLimits.secondary.used_percent, 45);
});

test('local HTTP routes enforce host, method, route, and CSP boundaries', async (t) => {
  const fixture = {
    config: { alertPercent: 85 },
    claude: { five: null, seven: null, stale: true },
    codex: { five: null, seven: null, stale: true },
    antigravity: { five: null, seven: null, stale: true },
  };
  const server = createDashboardServer({ usageProvider: async () => fixture });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-usage-dashboard'), '1');
  assert.deepEqual(await health.json(), { ok: true });

  const page = await fetch(`${base}/?mode=desktop`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.match(html, /Usage watch/);

  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/not-a-route?mode=desktop`)).status, 404);
  assert.equal((await fetch(`${base}/api/usage`, { method: 'POST' })).status, 405);

  const forbiddenStatus = await new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port: address.port,
      path: '/healthz',
      headers: { Host: 'evil.example' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(forbiddenStatus, 403);
  assert.equal(requestHostName('[::1]:8787'), '::1');
});
