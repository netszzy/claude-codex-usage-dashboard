'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPairingCode,
  createPhoneDisplayAccess,
  hasPhoneDisplayLaunchArgument,
  isPrivateIpv4Address,
  parseCookies,
  phoneDisplayAddresses,
  phoneDisplayEnabled,
  phoneDisplaySettings,
} = require('../lib/phone-display');
const { createPhoneDisplayServer } = require('../server');
const { REFRESH_VISIBLE_MS, displaySections, phoneAgents } = require('../phone-display');

test('phone display polls at the same visible cadence as the desktop dashboard', () => {
  assert.equal(REFRESH_VISIBLE_MS, 5000);
});

test('phone display access persists a high-entropy pairing credential', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-phone-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'phone-display.json');
  const randomBytes = (size) => Buffer.alloc(size, 31);

  const first = createPhoneDisplayAccess({ configPath, randomBytes });
  const second = createPhoneDisplayAccess({ configPath, randomBytes: () => { throw new Error('must reuse stored access'); } });

  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.pairingCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){2}$/);
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    token: first.token,
    pairingCode: first.pairingCode,
  });
  assert.equal(createPairingCode(randomBytes), 'ZZZZ-ZZZZ-ZZZZ');
});

test('phone display settings remain disabled unless explicitly enabled', () => {
  assert.deepEqual(phoneDisplaySettings({ env: {} }), { enabled: false });
  assert.equal(phoneDisplayEnabled('on'), true);
  assert.equal(phoneDisplayEnabled('off'), false);
  assert.throws(() => phoneDisplayEnabled('yes'), /PHONE_DISPLAY/);
  assert.throws(() => phoneDisplaySettings({ env: { PHONE_DISPLAY: 'on', PHONE_DISPLAY_PORT: '0' } }), /PHONE_DISPLAY_PORT/);
});

test('phone display launch argument is explicit', () => {
  assert.equal(hasPhoneDisplayLaunchArgument(['electron.exe', 'desktop/main.js', '--phone-display']), true);
  assert.equal(hasPhoneDisplayLaunchArgument(['electron.exe', 'desktop/main.js', '--phone-display=on']), false);
  assert.equal(hasPhoneDisplayLaunchArgument(null), false);
});

test('private IPv4 discovery excludes loopback and public addresses', () => {
  assert.equal(isPrivateIpv4Address('192.168.1.3'), true);
  assert.equal(isPrivateIpv4Address('172.20.0.7'), true);
  assert.equal(isPrivateIpv4Address('8.8.8.8'), false);
  assert.deepEqual(phoneDisplayAddresses({
    ethernet: [
      { family: 'IPv4', address: '192.168.5.7', internal: false },
      { family: 'IPv4', address: '127.0.0.1', internal: true },
    ],
    public: [{ family: 'IPv4', address: '203.0.113.5', internal: false }],
  }), ['192.168.5.7']);
});

test('phone display preserves the desktop-selected Agent order without a three-card limit', () => {
  const agents = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'grok', label: 'Grok' },
  ];
  const selected = phoneAgents({
    config: { visibleAgents: ['grok', 'claude', 'cursor', 'missing'] },
    agents,
  });
  assert.deepEqual(selected.map((agent) => agent.id), ['grok', 'claude', 'cursor']);
  assert.deepEqual(phoneAgents({ config: { visibleAgents: [] }, agents }), []);
});

test('phone display keeps every grouped quota window and omits only a duplicate top-level summary', () => {
  const resetAt = 1_800_000_000_000;
  const agent = {
    windows: [
      { label: '5H', used: 62, resetAt },
      { label: '7D', used: 30, resetAt: resetAt + 1 },
    ],
    groups: [
      {
        label: 'Gemini Models',
        windows: [
          { label: '5H', used: 0, resetAt },
          { label: '7D', used: 1, resetAt: resetAt + 1 },
        ],
      },
      {
        label: 'Claude and GPT models',
        windows: [
          { label: '5H', used: 62, resetAt },
          { label: '7D', used: 30, resetAt: resetAt + 1 },
        ],
      },
    ],
  };

  const sections = displaySections(agent);
  assert.deepEqual(sections.map((section) => section.label), ['Gemini Models', 'Claude and GPT models']);
  assert.deepEqual(sections.flatMap((section) => section.windows).map((windowData) => windowData.label), ['5H', '7D', '5H', '7D']);
  assert.ok(sections.flatMap((section) => section.windows).every((windowData) => windowData.resetAt));

  const distinctSummary = displaySections({ ...agent, windows: [
    { label: '5H', used: 62.1, resetAt },
    { label: '7D', used: 30, resetAt: resetAt + 1 },
  ] });
  assert.deepEqual(distinctSummary.map((section) => section.label), ['总览', 'Gemini Models', 'Claude and GPT models']);
});

test('phone display requires pairing before it serves the read-only usage API', async () => {
  const access = {
    token: Buffer.alloc(32, 7).toString('base64url'),
    pairingCode: 'ABCD-EFGH-JKLM',
  };
  const usage = {
    config: { alertPercent: 85, agents: [{ id: 'claude', defaultVisible: true }] },
    agents: [{ id: 'claude', label: 'Claude Code', windows: [{ label: '5H', used: 24 }] }],
  };
  const server = createPhoneDisplayServer({ usageProvider: () => usage, access });
  const testPort = 24000 + (process.pid % 10000);
  await new Promise((resolve) => server.listen(testPort, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const unpaired = await fetch(`${base}/phone/`);
    assert.equal(unpaired.status, 200);
    assert.match(await unpaired.text(), /配对码/);
    assert.match(unpaired.headers.get('content-security-policy'), /form-action 'self'/);
    assert.equal(unpaired.headers.get('x-usage-phone-display'), '1');

    const rejectedApi = await fetch(`${base}/phone/api/usage`);
    assert.equal(rejectedApi.status, 403);

    const failedPair = await fetch(`${base}/phone/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=WRONG-CODE-1234',
    });
    assert.equal(failedPair.status, 401);
    assert.match(failedPair.headers.get('content-security-policy'), /form-action 'self'/);

    const paired = await fetch(`${base}/phone/pair`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=ABCD-EFGH-JKLM',
    });
    assert.equal(paired.status, 303);
    assert.equal(paired.headers.get('location'), '/phone/');
    const cookie = paired.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const sessionCookie = cookie.split(';', 1)[0];
    assert.equal(parseCookies(sessionCookie).usage_watch_phone, access.token);

    const pairedPage = await fetch(`${base}/phone/`, { headers: { Cookie: sessionCookie } });
    assert.equal(pairedPage.status, 200);
    assert.match(await pairedPage.text(), /phone-display\.js/);

    const api = await fetch(`${base}/phone/api/usage`, { headers: { Cookie: sessionCookie } });
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), usage);

    const configRoute = await fetch(`${base}/api/config`, { headers: { Cookie: sessionCookie } });
    assert.equal(configRoute.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
