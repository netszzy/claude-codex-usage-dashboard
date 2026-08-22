'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexCollector } = require('../lib/collectors/codex');
const {
  createAntigravityCollector,
  parseAntigravityQuotaPayload,
} = require('../lib/collectors/antigravity');

function codexSession(fetchedAt) {
  return {
    fetchedAt,
    five: { used: 21, resetAt: 1234 },
    seven: { used: 42, resetAt: 5678 },
    source: 'codex-sessions',
    stale: false,
    staleAfterMs: 60000,
  };
}

test('Codex collector transitions from fresh direct data to stale data and then a newer session', async () => {
  let clock = 100;
  let session = codexSession(90);
  const direct = {
    fetchedAt: 101,
    five: { used: 11, resetAt: 1234 },
    seven: { used: 12, resetAt: 5678 },
    source: 'codex-app-server',
    stale: false,
    staleAfterMs: 120000,
  };
  const collector = createCodexCollector({
    now: () => clock,
    readUsage: () => session,
    queryRateLimits: async () => direct,
    sessionCacheMs: 1,
    refreshMs: 1,
  });

  assert.equal(collector.getCodexUsage().source, 'codex-sessions');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collector.getCodexUsage().source, 'codex-app-server');

  clock = direct.fetchedAt + direct.staleAfterMs + 2;
  const stale = collector.getCodexUsage();
  assert.equal(stale.source, 'codex-app-server');
  assert.equal(stale.stale, true);
  assert.equal(stale.five.resetAt, 1234);

  session = codexSession(clock + 1);
  clock += 2;
  const fallback = collector.getCodexUsage();
  assert.equal(fallback.source, 'codex-sessions');
  assert.equal(fallback.stale, false);
});

test('Antigravity protobuf fixture decodes quota buckets and incremental log scans retain cached ports', async (t) => {
  const payload = Buffer.from(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'antigravity-quota.base64'), 'utf8').trim(),
    'base64',
  );
  const groups = parseAntigravityQuotaPayload(payload);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'Claude');
  assert.equal(Math.round(groups[0].five.used), 58);
  assert.equal(Math.round(groups[0].seven.used), 20);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-antigravity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logDirectory = path.join(directory, 'logs');
  fs.mkdirSync(logDirectory);
  const settingsPath = path.join(directory, 'settings.json');
  const cachePath = path.join(directory, 'cache.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'Claude' }));
  const logPath = path.join(logDirectory, 'server.log');
  fs.writeFileSync(
    logPath,
    `${'x'.repeat(128 * 1024)}\nI0802 14:39:23 server.go:560] Language server listening on random port at 3428 for HTTPS (gRPC)\n`,
  );

  let bytesRead = 0;
  const trackedPromises = {
    readFile: (...args) => fs.promises.readFile(...args),
    readdir: (...args) => fs.promises.readdir(...args),
    stat: (...args) => fs.promises.stat(...args),
    open: async (...args) => {
      const handle = await fs.promises.open(...args);
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        bytesRead += readArgs[2];
        return read(...readArgs);
      };
      return handle;
    },
  };
  const collector = createAntigravityCollector({
    cachePath,
    callQuota: async () => payload,
    fsPromises: trackedPromises,
    logDirectory,
    settingsPath,
  });
  const first = await collector.readAntigravityUsage();
  assert.equal(first.stale, false);
  assert.ok(bytesRead >= 128 * 1024);
  const firstRead = bytesRead;
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8'))._logState.grpcPorts[0].port, 3428);

  fs.appendFileSync(
    logPath,
    'I0802 14:40:23 server.go:560] Language server listening on random port at 4428 for HTTPS (gRPC)\n',
  );
  const secondState = await collector.antigravityLogState();
  assert.equal(secondState.grpcPort, 4428);
  assert.ok(bytesRead - firstRead < 16384);

  fs.rmSync(logDirectory, { recursive: true, force: true });
  const fallbackCollector = createAntigravityCollector({ cachePath, logDirectory, settingsPath });
  const cachedState = await fallbackCollector.antigravityLogState();
  assert.equal(cachedState.grpcPort, 3428);
});
