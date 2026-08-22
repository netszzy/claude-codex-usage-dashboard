'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  accessTokenFromEntry,
  buildGrokSnapshot,
  ensureGrokAccessToken,
  fetchGrokUsage,
  hasUsableSnapshotWindows,
  parseCliArgs,
  parseGrokBillingPayload,
  periodWindowMeta,
  pickAuthEntry,
  productLabel,
  refreshGrokOAuthToken,
  runOnce,
} = require('../grok-usage-snapshot');

const NOW = Date.UTC(2026, 7, 2, 3, 0, 0);

function samplePayload() {
  return {
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-30T06:26:24.739855+00:00',
        end: '2026-08-06T06:26:24.739855+00:00',
      },
      creditUsagePercent: 4.0,
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      productUsage: [
        { product: 'GrokChat', usagePercent: 3.0 },
        { product: 'GrokBuild', usagePercent: 1.0 },
      ],
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      billingPeriodStart: '2026-07-30T06:26:24.739855+00:00',
      billingPeriodEnd: '2026-08-06T06:26:24.739855+00:00',
    },
  };
}

function writeAuth(directory, entry = {}) {
  const authPath = path.join(directory, 'auth.json');
  const slot = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
  const body = {
    [slot]: {
      key: 'access-token-live',
      auth_mode: 'oidc',
      refresh_token: 'refresh-token-live',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      oidc_issuer: 'https://auth.x.ai',
      ...entry,
    },
  };
  fs.writeFileSync(authPath, JSON.stringify(body, null, 2));
  return authPath;
}

test('Grok billing payload maps weekly credit usage to a 7D window', () => {
  const parsed = parseGrokBillingPayload(samplePayload());
  assert.deepEqual(parsed.windows, [{
    id: 'seven',
    label: '7D',
    used: 4,
    resetAt: Date.parse('2026-08-06T06:26:24.739855+00:00'),
  }]);
  assert.equal(parsed.groups.length, 2);
  assert.equal(parsed.groups[0].label, 'Grok Chat');
  assert.equal(parsed.groups[1].label, 'Grok Build');
  assert.equal(periodWindowMeta('USAGE_PERIOD_TYPE_MONTHLY').label, '30D');
  assert.equal(productLabel('GrokBuild'), 'Grok Build');
});

test('Grok snapshots keep the overall credit window and omit product groups', () => {
  const snapshot = buildGrokSnapshot(samplePayload(), NOW, { label: 'Grok', staleAfterMs: 60000 });
  assert.equal(snapshot.label, 'Grok');
  assert.equal(snapshot.source, 'grok-billing-credits');
  assert.equal(snapshot.fetchedAt, NOW);
  assert.equal(snapshot.staleAfterMs, 60000);
  assert.deepEqual(snapshot.windows.map((windowData) => windowData.id), ['seven']);
  assert.deepEqual(snapshot.groups, []);
  assert.equal(hasUsableSnapshotWindows(snapshot), true);
  assert.throws(() => buildGrokSnapshot({}, NOW, {}), /no usable credit usage/);
});

test('Grok bridge writes the snapshot through an injected fetch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, 'grok.json');
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
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
  assert.equal(written.windows[0].used, 4);
  assert.equal(written.source, 'grok-billing-credits');
});

test('Grok bridge keeps the last good snapshot when a refresh fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, 'grok.json');
  fs.writeFileSync(snapshotPath, JSON.stringify({
    label: 'Grok',
    source: 'grok-billing-credits',
    fetchedAt: NOW - 1000,
    windows: [{ id: 'seven', label: '7D', used: 11, resetAt: null }],
  }));

  const result = await runOnce({
    snapshotPath,
    token: 'test-token',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => 'nope',
    }),
    logger: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.keptLastGood, true);
  const written = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(written.windows[0].used, 11);
});

test('Grok bridge writes an error stub only when no usable snapshot exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, 'grok.json');

  const result = await runOnce({
    snapshotPath,
    token: 'test-token',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }),
    logger: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.keptLastGood, false);
  const written = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(written.stale, true);
  assert.match(written.error, /401/);
  assert.deepEqual(written.windows, []);
});

test('Grok auth picker prefers a live OIDC slot and respects expiry skew', () => {
  const authPathish = {
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
      key: 'good',
      refresh_token: 'r',
      auth_mode: 'oidc',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    'other': { key: 'bad' },
  };
  const picked = pickAuthEntry(authPathish);
  assert.equal(picked.value.key, 'good');
  assert.equal(accessTokenFromEntry({ key: 'x', expires_at: new Date(Date.now() + 10_000).toISOString() }), null);
  assert.equal(accessTokenFromEntry({ key: 'x', expires_at: new Date(Date.now() + 120_000).toISOString() }), 'x');
});

test('Grok bridge CLI args default to one-shot and parse watch intervals', () => {
  assert.deepEqual(parseCliArgs([]), { watch: false, intervalSeconds: 300 });
  assert.equal(parseCliArgs(['--watch', '90']).watch, true);
  assert.equal(parseCliArgs(['--watch', '90']).intervalSeconds, 90);
  assert.equal(parseCliArgs(['--interval=120']).intervalSeconds, 120);
  assert.equal(parseCliArgs(['--no-write-back']).writeBack, false);
});

test('Grok bridge refreshes an expired OAuth token and rewrites auth.json', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authPath = writeAuth(directory, {
    key: 'expired-token',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });

  const fetchImpl = async (url, options) => {
    if (url === 'https://auth.x.ai/oauth2/token') {
      assert.equal(options.method, 'POST');
      assert.match(options.body, /grant_type=refresh_token/);
      assert.match(options.body, /refresh_token=refresh-token-live/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_in: 3600,
        }),
      };
    }
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
    assert.equal(options.headers.Authorization, 'Bearer fresh-access');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(samplePayload()),
    };
  };

  const token = await ensureGrokAccessToken({ authPath, fetchImpl });
  assert.equal(token, 'fresh-access');
  const rewritten = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const entry = Object.values(rewritten)[0];
  assert.equal(entry.key, 'fresh-access');
  assert.equal(entry.refresh_token, 'fresh-refresh');
  const backup = JSON.parse(fs.readFileSync(`${authPath}.bak`, 'utf8'));
  assert.equal(Object.values(backup)[0].key, 'expired-token');
  assert.equal(fs.existsSync(`${authPath}.grok-usage.lock`), false);

  const payload = await fetchGrokUsage({ authPath, fetchImpl });
  assert.equal(payload.config.creditUsagePercent, 4);
});

test('Grok credential refresh can skip write-back and never overwrites a malformed target', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authPath = writeAuth(directory, {
    key: 'expired-token',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
  });
  const valid = fs.readFileSync(authPath, 'utf8');

  assert.equal(
    await refreshGrokOAuthToken({ authPath, fetchImpl, writeBack: false }),
    'fresh-access',
  );
  assert.equal(fs.readFileSync(authPath, 'utf8'), valid);
  assert.equal(fs.existsSync(`${authPath}.bak`), false);

  const malformed = JSON.stringify({
    'https://auth.x.ai::client': {
      refresh_token: 'refresh-token-live',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  fs.writeFileSync(authPath, malformed);
  const warnings = [];
  assert.equal(
    await refreshGrokOAuthToken({ authPath, fetchImpl, warn: (message) => warnings.push(message) }),
    'fresh-access',
  );
  assert.equal(fs.readFileSync(authPath, 'utf8'), malformed);
  assert.equal(fs.existsSync(`${authPath}.bak`), false);
  assert.match(warnings[0], /has no key/);
});

test('Grok bridge reports a rejected refresh token as a re-login requirement', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-cred-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const authPath = writeAuth(directory, {
    key: 'expired-token',
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });

  await assert.rejects(
    refreshGrokOAuthToken({
      authPath,
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }),
    }),
    /run grok login again/,
  );
  assert.equal(fs.existsSync(`${authPath}.grok-usage.lock`), false);
});
