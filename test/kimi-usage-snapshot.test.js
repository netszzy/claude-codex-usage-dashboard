'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  acquireTokenLock,
  buildKimiSnapshot,
  ensureKimiAccessToken,
  fetchKimiUsage,
  hasUsableSnapshotWindows,
  parseCliArgs,
  parseKimiUsagePayload,
  quotaWindowFromDetail,
  readKimiAccessToken,
  refreshKimiOAuthToken,
  runOnce,
} = require('../kimi-usage-snapshot');

const NOW = Date.UTC(2026, 6, 17, 2, 30, 0);

function samplePayload() {
  return {
    user: { userId: 'u-1', membership: { level: 'LEVEL_INTERMEDIATE' } },
    usage: { limit: '100', used: '8', remaining: '92', resetTime: '2026-07-24T00:21:32.001571Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '42', remaining: '58', resetTime: '2026-07-17T05:21:32.001571Z' },
      },
    ],
    parallel: { limit: '20' },
  };
}

test('Kimi usage payload maps the rolling 5-hour window and the 7-day quota', () => {
  const windows = parseKimiUsagePayload(samplePayload());

  assert.deepEqual(windows.five, {
    used: 42,
    resetAt: Date.parse('2026-07-17T05:21:32.001571Z'),
  });
  assert.deepEqual(windows.seven, {
    used: 8,
    resetAt: Date.parse('2026-07-24T00:21:32.001571Z'),
  });
});

test('Kimi 5-hour window is selected by duration when several limits exist', () => {
  const payload = samplePayload();
  payload.limits.unshift({
    window: { duration: 1440, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '500', used: '50', remaining: '450', resetTime: '2026-07-18T00:00:00Z' },
  });

  const windows = parseKimiUsagePayload(payload);
  assert.equal(windows.five.used, 42);
});

test('Kimi quota details reject zero or invalid limits and clamp percentages', () => {
  assert.equal(quotaWindowFromDetail({ limit: '0', used: '10' }), null);
  assert.equal(quotaWindowFromDetail({ limit: 'abc', used: '10' }), null);
  assert.equal(quotaWindowFromDetail(null), null);
  const over = quotaWindowFromDetail({ limit: '50', used: '80', resetTime: 'bad-date' });
  assert.equal(over.used, 100);
  assert.equal(over.resetAt, null);
  const ratio = quotaWindowFromDetail({ limit: '200', used: '42' });
  assert.equal(ratio.used, 21);
});

test('Kimi snapshots keep dashboard window ids and drop unusable windows', () => {
  const snapshot = buildKimiSnapshot(samplePayload(), NOW, { label: 'Kimi Code', staleAfterMs: 60000 });

  assert.equal(snapshot.label, 'Kimi Code');
  assert.equal(snapshot.source, 'kimi-code-usages');
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.staleAfterMs, 60000);
  assert.deepEqual(snapshot.windows.map((windowData) => windowData.id), ['five', 'seven']);
  assert.equal(hasUsableSnapshotWindows(snapshot), true);

  const partial = buildKimiSnapshot({ usage: samplePayload().usage }, NOW, {});
  assert.deepEqual(partial.windows.map((windowData) => windowData.id), ['seven']);

  assert.throws(() => buildKimiSnapshot({}, NOW, {}), /no usable quota windows/);
});

test('Kimi bridge writes the snapshot through an injected fetch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, 'kimi.json');
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.kimi.com/coding/v1/usages');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(samplePayload()),
    };
  };

  const result = await runOnce({
    snapshotPath,
    token: 'test-token',
    fetchImpl,
    now: () => NOW,
    logger: () => {},
  });

  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(written.windows[0].used, 42);
  assert.equal(written.windows[1].resetAt, Date.parse('2026-07-24T00:21:32.001571Z'));
  assert.equal(JSON.stringify(written).includes('test-token'), false);
});

test('Kimi bridge keeps the last good snapshot when a refresh fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, 'kimi.json');
  const good = buildKimiSnapshot(samplePayload(), NOW, {});
  fs.writeFileSync(snapshotPath, JSON.stringify(good, null, 2));

  const failingFetch = async () => ({ ok: false, status: 401, text: async () => '{}' });
  const result = await runOnce({
    snapshotPath,
    token: 'test-token',
    fetchImpl: failingFetch,
    now: () => NOW + 60000,
    logger: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.keptLastGood, true);
  assert.match(result.error, /401/);
  const onDisk = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(onDisk.windows[0].used, 42);
  assert.equal(onDisk.fetchedAt, NOW);
});

test('Kimi bridge writes an error stub only when no usable snapshot exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, 'kimi.json');
  const failingFetch = async () => {
    throw new Error('network down');
  };

  const result = await runOnce({
    snapshotPath,
    token: 'test-token',
    fetchImpl: failingFetch,
    now: () => NOW,
    logger: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.keptLastGood, false);
  const stub = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(stub.error, 'network down');
  assert.deepEqual(stub.windows, []);
  assert.equal(hasUsableSnapshotWindows(stub), false);
});

test('Kimi access tokens come from the override or the CLI credential file', (t) => {
  assert.equal(readKimiAccessToken({ token: 'inline-token' }), 'inline-token');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'file-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  assert.equal(readKimiAccessToken({ credentialsPath }), 'file-token');

  assert.throws(
    () => readKimiAccessToken({ credentialsPath: path.join(directory, 'missing.json') }),
    /not found/,
  );

  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'expired-token',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  }));
  assert.throws(() => readKimiAccessToken({ credentialsPath }), /expired/);
});

test('Kimi bridge CLI args default to one-shot and parse watch intervals', () => {
  assert.deepEqual(parseCliArgs([]), { watch: false, intervalSeconds: 300 });
  assert.deepEqual(parseCliArgs(['--watch']), { watch: true, intervalSeconds: 300 });
  assert.deepEqual(parseCliArgs(['--watch', '60']), { watch: true, intervalSeconds: 60 });
  assert.deepEqual(parseCliArgs(['--interval=900']), { watch: true, intervalSeconds: 900 });
  assert.deepEqual(parseCliArgs(['--watch', '5']), { watch: true, intervalSeconds: 30 });
  assert.deepEqual(parseCliArgs(['--watch', '--once']), { watch: false, intervalSeconds: 300 });
  assert.deepEqual(parseCliArgs(['--no-write-back']), {
    watch: false,
    intervalSeconds: 300,
    writeBack: false,
  });
});

test('Kimi access token reuses a still-valid cached credential without HTTP', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'cached-at',
    refresh_token: 'cached-rt',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const fetchImpl = async () => {
    throw new Error('fetch must not be called for a valid cached token');
  };

  const token = await ensureKimiAccessToken({ credentialsPath, fetchImpl });
  assert.equal(token, 'cached-at');
  assert.equal(fs.existsSync(`${credentialsPath}.kimi-usage.lock`), false);
});

test('Kimi bridge refreshes an expired OAuth token and rewrites the credential file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'expired-at',
    refresh_token: 'old-rt',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    scope: 'kimi-code',
    token_type: 'Bearer',
    extra_field: 'keep-me',
  }));
  const before = Math.floor(Date.now() / 1000);
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://auth.kimi.com/api/oauth/token');
    assert.equal(options.method, 'POST');
    assert.match(options.body, /grant_type=refresh_token/);
    assert.match(options.body, /client_id=17e5f671-d194-4dfb-9706-5516cb48c098/);
    assert.match(options.body, /refresh_token=old-rt/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 900,
        scope: 'kimi-code',
        token_type: 'Bearer',
      }),
    };
  };

  const token = await ensureKimiAccessToken({ credentialsPath, fetchImpl });

  assert.equal(token, 'new-at');
  const rewritten = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.equal(rewritten.access_token, 'new-at');
  assert.equal(rewritten.refresh_token, 'new-rt');
  assert.equal(rewritten.extra_field, 'keep-me');
  assert.ok(rewritten.expires_at >= before + 890 && rewritten.expires_at <= before + 910);
  const backup = JSON.parse(fs.readFileSync(`${credentialsPath}.bak`, 'utf8'));
  assert.equal(backup.access_token, 'expired-at');
  assert.equal(backup.refresh_token, 'old-rt');
  assert.equal(fs.existsSync(`${credentialsPath}.kimi-usage.lock`), false);
});

test('Kimi credential refresh can skip write-back and never overwrites a malformed target', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 900 }),
  });
  const valid = JSON.stringify({
    access_token: 'expired-at',
    refresh_token: 'old-rt',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  });
  fs.writeFileSync(credentialsPath, valid);

  assert.equal(
    await refreshKimiOAuthToken({ credentialsPath, fetchImpl, writeBack: false }),
    'new-at',
  );
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), valid);
  assert.equal(fs.existsSync(`${credentialsPath}.bak`), false);

  const malformed = JSON.stringify({
    refresh_token: 'old-rt',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  });
  fs.writeFileSync(credentialsPath, malformed);
  const warnings = [];
  assert.equal(
    await refreshKimiOAuthToken({ credentialsPath, fetchImpl, warn: (message) => warnings.push(message) }),
    'new-at',
  );
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), malformed);
  assert.equal(fs.existsSync(`${credentialsPath}.bak`), false);
  assert.match(warnings[0], /access_token is missing/);
});

test('Kimi bridge reports a rejected refresh token as a re-login requirement', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'expired-at',
    refresh_token: 'dead-rt',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  }));
  const fetchImpl = async () => ({ ok: false, status: 400 });

  await assert.rejects(
    ensureKimiAccessToken({ credentialsPath, fetchImpl }),
    /login again/,
  );
  assert.equal(fs.existsSync(`${credentialsPath}.kimi-usage.lock`), false);
});

test('Kimi bridge self-heals when the CLI refreshed the credential during our refresh', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'expired-at',
    refresh_token: 'old-rt',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  }));
  const fetchImpl = async () => {
    fs.writeFileSync(credentialsPath, JSON.stringify({
      access_token: 'cli-healed-at',
      refresh_token: 'cli-rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }));
    return { ok: false, status: 400 };
  };

  const token = await ensureKimiAccessToken({ credentialsPath, fetchImpl });
  assert.equal(token, 'cli-healed-at');
});

test('Kimi token lock breaks a stale lock file and respects a fresh one', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, 'kimi-code.json.kimi-usage.lock');

  fs.writeFileSync(lockPath, '99999\n');
  const stale = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, stale, stale);
  assert.equal(acquireTokenLock(lockPath), true);
  fs.unlinkSync(lockPath);

  fs.writeFileSync(lockPath, '99999\n');
  assert.equal(acquireTokenLock(lockPath), false);
  fs.unlinkSync(lockPath);
});

test('Kimi usage fetch retries once with a forced refresh after a 401', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, 'kimi-code.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'expired-at',
    refresh_token: 'old-rt',
    expires_at: Math.floor(Date.now() / 1000) - 3600,
  }));
  let usagesCalls = 0;
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://auth.kimi.com/api/oauth/token') {
      tokenCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `refreshed-at-${tokenCalls}`,
          refresh_token: `rt-${tokenCalls}`,
          expires_in: 900,
        }),
      };
    }
    assert.equal(url, 'https://api.kimi.com/coding/v1/usages');
    usagesCalls += 1;
    if (usagesCalls === 1) return { ok: false, status: 401 };
    return { ok: true, status: 200, text: async () => JSON.stringify(samplePayload()) };
  };

  const payload = await fetchKimiUsage({ credentialsPath, fetchImpl });

  assert.equal(usagesCalls, 2);
  assert.equal(tokenCalls, 2);
  assert.equal(payload.usage.used, '8');
  const rewritten = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.equal(rewritten.access_token, 'refreshed-at-2');
  assert.equal(fs.existsSync(`${credentialsPath}.kimi-usage.lock`), false);
});

test('Kimi usage fetch does not retry a 401 when an explicit token was supplied', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 401 };
  };

  await assert.rejects(
    fetchKimiUsage({ token: 'explicit-token', fetchImpl }),
    /401/,
  );
  assert.equal(calls, 1);
});
