'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDashboardConfig } = require('../lib/dashboard-config');
const { createDashboardServer } = require('../server');

test('usage responses support ETag revalidation and local config updates reject unknown fields', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'dashboard-config.json');
  const configStore = createDashboardConfig({ configPath, env: {} });
  const usage = {
    config: { alertPercent: 85, bridges: { kimi: true, grok: true }, agents: [] },
    agents: [],
    claude: {},
    codex: {},
    antigravity: {},
  };
  const server = createDashboardServer({ usageProvider: () => usage, configStore });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const first = await fetch(`${base}/api/usage`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const second = await fetch(`${base}/api/usage`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);

    const noOrigin = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertPercent: 70 }),
    });
    assert.equal(noOrigin.status, 403);

    const updated = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ alertPercent: 70, bridges: { kimi: false } }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).config, {
      alertPercent: 70,
      bridges: { kimi: false, grok: true },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      alertPercent: 70,
      bridges: { kimi: false, grok: true },
    });

    const rejected = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ secret: true }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('environment values override persisted dashboard controls without discarding the saved preference', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'dashboard-config.json');
  const configStore = createDashboardConfig({
    configPath,
    env: { ALERT_PERCENT: '91', KIMI_USAGE_BRIDGE: 'off' },
  });

  assert.deepEqual(configStore.update({ alertPercent: 70, bridges: { kimi: true, grok: false } }), {
    alertPercent: 91,
    bridges: { kimi: false, grok: false },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    alertPercent: 70,
    bridges: { kimi: true, grok: false },
  });
});
