'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ageText,
  normalizeSettings,
  quotaLevel,
  resetText,
  requestDesktopResize,
  resolveLayout,
  settingsWindowHeight,
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

test('dashboard settings keep valid selections and fall back to configured defaults', () => {
  const catalog = [
    { id: 'claude', defaultVisible: true },
    { id: 'gemini', defaultVisible: false },
    { id: 'cursor', defaultVisible: false },
  ];
  assert.deepEqual(normalizeSettings(null, catalog), {
    visibleAgents: ['claude'],
    density: 'auto',
  });
  assert.deepEqual(normalizeSettings({
    visibleAgents: ['gemini', 'missing', 'gemini', 'cursor'],
    density: 'compact',
  }, catalog), {
    visibleAgents: ['gemini', 'cursor'],
    density: 'compact',
  });
});

test('adaptive layout changes density and columns with the selected agent count', () => {
  assert.deepEqual(resolveLayout(1, 'auto'), {
    columns: 1,
    density: 'standard',
    width: 240,
    height: 176,
  });
  assert.deepEqual(resolveLayout(1, 'compact'), {
    columns: 1,
    density: 'compact',
    width: 240,
    height: 164,
  });
  assert.deepEqual(resolveLayout(1, 'comfortable'), {
    columns: 1,
    density: 'comfortable',
    width: 320,
    height: 194,
  });
  assert.equal(resolveLayout(1, 'auto', true).width, 320);
  assert.equal(resolveLayout(1, 'compact', true).width, 320);
  assert.deepEqual(resolveLayout(2, 'auto'), {
    columns: 2,
    density: 'standard',
    width: 380,
    height: 176,
  });
  assert.equal(resolveLayout(3, 'auto').columns, 2);
  assert.equal(resolveLayout(6, 'auto').columns, 3);
  assert.equal(resolveLayout(6, 'auto').density, 'compact');
  assert.equal(resolveLayout(4, 'comfortable').width, 500);
  assert.deepEqual(resolveLayout(6, 'auto'), {
    columns: 3,
    density: 'compact',
    width: 600,
    height: 266,
  });
  assert.equal(resolveLayout(9, 'comfortable').height, 640);
  assert.equal(resolveLayout(11, 'standard').height, 640);
  assert.equal(resolveLayout(19, 'auto').height, 640);
  assert.equal(resolveLayout(32, 'auto').height, 640);
});

test('polling does not replay an estimated height after the target width was requested', async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const resizeCalls = [];
  const dashboardClasses = new Set();
  let dashboardHeight = 152;
  const readouts = { scrollTop: 0 };
  const dashboard = {
    classList: {
      add: (name) => dashboardClasses.add(name),
      contains: (name) => dashboardClasses.has(name),
      remove(name) {
        dashboardClasses.delete(name);
        if (name === 'is-scrollable') readouts.scrollTop = 0;
      },
    },
    getBoundingClientRect: () => ({ height: dashboardHeight }),
  };
  global.window = {
    innerWidth: 160,
    desktopHud: {
      resize(width, height) {
        resizeCalls.push([width, height]);
      },
    },
  };
  global.document = {
    getElementById(id) {
      return id === 'dashboard' ? dashboard : id === 'readouts' ? readouts : null;
    },
  };

  try {
    requestDesktopResize({ width: 240, height: 176 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    resizeCalls.length = 0;

    requestDesktopResize({ width: 240, height: 176 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, []);

    requestDesktopResize({ width: 320, height: 176 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[320, 176], [320, 160]]);

    resizeCalls.length = 0;
    dashboardHeight = 700;
    requestDesktopResize({ width: 320, height: 404 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[320, 640]]);
    assert.equal(dashboardClasses.has('is-scrollable'), true);

    resizeCalls.length = 0;
    readouts.scrollTop = 42;
    requestDesktopResize({ width: 320, height: 404 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, []);
    assert.equal(readouts.scrollTop, 42);

    resizeCalls.length = 0;
    dashboardHeight = 520;
    requestDesktopResize({ width: 500, height: 458 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[500, 640], [500, 528]]);
    assert.equal(dashboardClasses.has('is-scrollable'), false);

    resizeCalls.length = 0;

    requestDesktopResize({ width: 500, height: 640 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[500, 640]]);
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});

test('settings window is tall enough for built-in choices and capped for long catalogs', () => {
  assert.equal(settingsWindowHeight(0), 420);
  assert.equal(settingsWindowHeight(7), 462);
  assert.equal(settingsWindowHeight(32), 600);
});

test('main quota card keeps reset countdowns visible and legible at standard density', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  const hiddenResetRules = Array.from(stylesheet.matchAll(/([^{}]+)\{([^{}]+)\}/g))
    .filter(([, selector, body]) => selector.includes('.reset-text') && /display\s*:\s*none/.test(body));
  const script = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

  assert.deepEqual(hiddenResetRules, []);
  assert.match(stylesheet, /\.quota-ring\s*\{[^}]*width:\s*48px;[^}]*height:\s*48px;/s);
  assert.match(stylesheet, /\.quota-value\s*\{[^}]*font-size:\s*14px;/s);
  assert.match(stylesheet, /\.window-label\s*\{[^}]*font-size:\s*10px;[^}]*font-weight:\s*500;/s);
  assert.match(stylesheet, /\.reset-text\s*\{[^}]*font-size:\s*11\.5px;[^}]*font-weight:\s*650;/s);
  assert.match(stylesheet, /\[data-density="compact"\] \.quota-ring\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s);
  assert.match(stylesheet, /\.watch\.is-scrollable \.readouts\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(script, /element\('span', 'reset-text', resetLabel\)/);
});
