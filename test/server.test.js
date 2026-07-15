'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildAgentCatalog,
  isUsableAntigravityData,
  normalizeAgentSnapshot,
  normalizeCodexRateLimits,
  parseCodexEventLine,
  readExternalAgentSnapshots,
  readLatestCodexSnapshot,
  requestHostName,
  writeJsonAtomic,
} = require('../server');

test('Codex quota windows follow window duration when the 5-hour limit is absent', () => {
  const windows = normalizeCodexRateLimits({
    primary: { used_percent: 27, window_minutes: 10080, resets_at: 1784666151 },
    secondary: null,
  });

  assert.equal(windows.five, null);
  assert.deepEqual(windows.seven, {
    used: 27,
    resetAt: 1784666151000,
  });
});

test('Codex quota windows preserve legacy slot mapping without duration metadata', () => {
  const windows = normalizeCodexRateLimits({
    primary: { used_percent: 12 },
    secondary: { used_percent: 34 },
  });

  assert.equal(windows.five.used, 12);
  assert.equal(windows.seven.used, 34);
});

test('Codex snapshots are read backwards without loading an oversized trailing line', () => {
  const filePath = path.join(os.tmpdir(), `usage-dashboard-codex-test-${process.pid}.jsonl`);
  const now = Date.UTC(2026, 6, 14, 12, 0, 0);
  fs.writeFileSync(filePath, [
    JSON.stringify({ timestamp: new Date(now - 3600_000).toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 12 }, secondary: { used_percent: 34 } } } }),
    JSON.stringify({ timestamp: new Date(now).toISOString(), payload: { type: 'token_count', rate_limits: { primary: { used_percent: 56 }, secondary: { used_percent: 78 } } } }),
  ].join('\n') + '\n');
  try {
    const snapshot = readLatestCodexSnapshot(filePath);
    assert.ok(snapshot);
    assert.equal(snapshot.rateLimits.primary.used_percent, 56);
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

test('external agent snapshots normalize common quota windows without exposing arbitrary fields', () => {
  const now = Date.UTC(2026, 6, 14, 10, 0, 0);
  const snapshot = normalizeAgentSnapshot({
    label: 'Gemini CLI',
    fetchedAt: now - 60_000,
    staleAfterMs: 120_000,
    secret: 'must not escape',
    windows: [
      { id: 'daily', label: 'DAY', used: 37.4, resetAt: now + 3600_000 },
      { id: 'pro', label: 'PRO', used: 112 },
    ],
  }, { id: 'gemini', source: 'local-bridge' }, now);

  assert.equal(snapshot.id, 'gemini');
  assert.equal(snapshot.windows[0].used, 37.4);
  assert.equal(snapshot.windows[1].used, 100);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.available, true);
  assert.equal('secret' in snapshot, false);
});

test('external agent discovery accepts known and custom local bridge files only', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-agents-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'gemini.json'), JSON.stringify({
    fetchedAt: Date.now(),
    windows: [{ id: 'daily', label: 'DAY', used: 21 }],
  }));
  fs.writeFileSync(path.join(directory, 'my-agent.json'), JSON.stringify({
    label: 'My Agent',
    windows: [{ id: 'daily', label: 'DAY', used: 42 }],
  }));
  fs.writeFileSync(path.join(directory, 'not-json.txt'), 'not json');
  const agents = readExternalAgentSnapshots(directory);
  assert.equal(agents.length, 2);
  assert.ok(agents.some((a) => a.id === 'gemini'));
  assert.ok(agents.some((a) => a.id === 'my-agent'));
});

test('local HTTP routes enforce host, method, route, and CSP boundaries', async () => {
  const { createDashboardServer } = require('../server');
  const server = createDashboardServer({
    usageProvider: () => ({ config: { alertPercent: 85, agents: [] }, agents: [], claude: {}, codex: {}, antigravity: {} }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const base = `http://127.0.0.1:${port}`;
    const resHealth = await fetch(`${base}/healthz`);
    assert.equal(resHealth.status, 200);
    const resApi = await fetch(`${base}/api/usage`);
    assert.equal(resApi.status, 200);
    assert.equal(resApi.headers.get('x-usage-dashboard'), '1');
    const resCss = await fetch(`${base}/dashboard.css`);
    assert.equal(resCss.status, 200);
    assert.ok(resCss.headers.get('content-type').includes('css'));
  } finally {
    server.close();
  }
});
