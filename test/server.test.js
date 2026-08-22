'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  antigravityLineTimestamp,
  buildAgentCatalog,
  normalizeAgentSnapshot,
  normalizeCodexAppServerRateLimits,
  normalizeCodexRateLimits,
  queryCodexAppServerRateLimits,
  readExternalAgentSnapshots,
  readLatestCodexSnapshot,
} = require('../server');

function fakeCodexAppServerSpawn(onSpawn) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
  };
  let input = '';
  child.stdin.on('data', (chunk) => {
    input += chunk;
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const message = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      }
      if (message.method === 'account/rateLimits/read') {
        child.stdout.write(`${JSON.stringify({
          id: 2,
          result: {
            rateLimits: {
              primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1784785702 },
              secondary: null,
            },
          },
        })}\n`);
      }
      newline = input.indexOf('\n');
    }
  });
  process.nextTick(() => {
    onSpawn(child);
    child.emit('spawn');
  });
  return child;
}

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

test('Codex app-server responses normalize current camelCase quota fields', () => {
  const now = Date.UTC(2026, 6, 16, 8, 0, 0);
  const usage = normalizeCodexAppServerRateLimits({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1784785702 },
        secondary: null,
      },
    },
  }, now);

  assert.equal(usage.fetchedAt, now);
  assert.equal(usage.source, 'codex-app-server');
  assert.equal(usage.five, null);
  assert.deepEqual(usage.seven, { used: 2, resetAt: 1784785702000 });
});

test('Codex app-server client initializes and reads limits without starting a turn', async () => {
  let spawnCall = null;
  const spawnImpl = (executable, args, options) => fakeCodexAppServerSpawn(() => {
    spawnCall = { executable, args, options };
  });
  const now = Date.UTC(2026, 6, 16, 8, 0, 0);
  const usage = await queryCodexAppServerRateLimits({
    executable: 'codex-test',
    spawnImpl,
    timeoutMs: 1000,
    now: () => now,
  });

  assert.equal(spawnCall.executable, 'codex-test');
  assert.deepEqual(spawnCall.args, ['app-server', '--stdio']);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.env.RUST_LOG, 'error');
  assert.equal(usage.source, 'codex-app-server');
  assert.equal(usage.seven.used, 2);
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


const {
  createGrokUsageBridgeRefresher,
  createKimiUsageBridgeRefresher,
  refreshGrokUsageSnapshot,
  refreshKimiUsageSnapshot,
} = require('../server');

function fakeUsageBridgeSpawn({ code = 0, stderr = '' } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ executable, args, options, child });
    process.nextTick(() => {
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
      child.emit('exit', code);
    });
    return child;
  };
  return { calls, spawnImpl };
}

test('Kimi usage bridge spawn runs the snapshot script as plain node', async () => {
  const { calls, spawnImpl } = fakeUsageBridgeSpawn();
  await refreshKimiUsageSnapshot({ spawnImpl, scriptPath: 'bridge.js', timeoutMs: 1000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, ['bridge.js']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('Kimi usage bridge spawn surfaces stderr on failure', async () => {
  const { spawnImpl } = fakeUsageBridgeSpawn({ code: 1, stderr: 'boom' });
  await assert.rejects(
    refreshKimiUsageSnapshot({ spawnImpl, scriptPath: 'bridge.js', timeoutMs: 1000 }),
    /boom/,
  );
});

test('Kimi usage bridge refresher throttles spawns and warns once per failure', async () => {
  const { calls, spawnImpl } = fakeUsageBridgeSpawn({ code: 1, stderr: 'denied' });
  const warnings = [];
  const refresh = createKimiUsageBridgeRefresher({
    enabled: true,
    refreshMs: 1000,
    spawnImpl,
    scriptPath: 'bridge.js',
    timeoutMs: 1000,
    warn: (message) => warnings.push(message),
  });
  const start = Date.now();

  assert.equal(refresh(start), true);
  assert.equal(refresh(start + 10), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refresh(start + 500), false);
  assert.equal(refresh(start + 1001), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /denied/);

  const disabled = createKimiUsageBridgeRefresher({ enabled: false, spawnImpl });
  assert.equal(disabled(), false);
  assert.equal(calls.length, 2);
});

test('Grok usage bridge spawn runs the snapshot script as plain node', async () => {
  const { calls, spawnImpl } = fakeUsageBridgeSpawn();
  await refreshGrokUsageSnapshot({ spawnImpl, scriptPath: 'grok-bridge.js', timeoutMs: 1000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, ['grok-bridge.js']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
});

test('Grok usage bridge spawn surfaces stderr on failure', async () => {
  const { spawnImpl } = fakeUsageBridgeSpawn({ code: 1, stderr: 'billing denied' });
  await assert.rejects(
    refreshGrokUsageSnapshot({ spawnImpl, scriptPath: 'grok-bridge.js', timeoutMs: 1000 }),
    /billing denied/,
  );
});

test('Grok usage bridge refresher throttles spawns and warns once per failure', async () => {
  const { calls, spawnImpl } = fakeUsageBridgeSpawn({ code: 1, stderr: 'no auth' });
  const warnings = [];
  const refresh = createGrokUsageBridgeRefresher({
    enabled: true,
    refreshMs: 1000,
    spawnImpl,
    scriptPath: 'grok-bridge.js',
    timeoutMs: 1000,
    warn: (message) => warnings.push(message),
  });
  const start = Date.now();

  assert.equal(refresh(start), true);
  assert.equal(refresh(start + 10), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refresh(start + 500), false);
  assert.equal(refresh(start + 1001), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no auth/);

  const disabled = createGrokUsageBridgeRefresher({ enabled: false, spawnImpl });
  assert.equal(disabled(), false);
  assert.equal(calls.length, 2);
});

test('agent catalog includes Grok as a local-bridge preset', () => {
  const catalog = buildAgentCatalog([]);
  const grok = catalog.find((agent) => agent.id === 'grok');
  assert.ok(grok);
  assert.equal(grok.label, 'Grok');
  assert.equal(grok.source, 'local-bridge');
  assert.equal(grok.defaultVisible, false);
  assert.equal(grok.bridgeFile, 'grok.json');
  assert.equal(grok.available, false);
});

test('antigravityLineTimestamp parses standard and prefixed log line timestamps', () => {
  const fileTime = new Date('2026-08-02T14:39:23Z').getTime();
  const standardLine = 'I0802 14:39:23.601498      82 server.go:560] Language server listening on random port at 3428 for HTTPS (gRPC)';
  const prefixedLine = 'ERROR: logging before google.Init: I0802 14:39:23.601498      82 server.go:560] Language server listening on random port at 3428 for HTTPS (gRPC)';

  const tsStandard = antigravityLineTimestamp(standardLine, fileTime);
  const tsPrefixed = antigravityLineTimestamp(prefixedLine, fileTime);

  assert.ok(tsStandard);
  assert.ok(tsPrefixed);
  assert.equal(tsStandard, tsPrefixed);
});

