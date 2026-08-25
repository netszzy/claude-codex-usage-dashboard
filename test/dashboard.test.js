'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  abbreviateGroupLabel,
  abbreviateLabel,
  ageText,
  agentSignature,
  choiceState,
  createUsageRefresher,
  installUsagePolling,
  normalizeSettings,
  offlineUsage,
  overallState,
  quotaLevel,
  quotaTitle,
  resetText,
  requestDesktopResize,
  resolveLayout,
  settingsWindowHeight,
  serviceState,
  stripMiniContentWidth,
  usageSignature,
} = require('../dashboard');

test('expired reset timestamps are not projected into a future cycle', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  assert.equal(resetText(now - 60_000, now), '已到期');
  assert.equal(resetText(now + 90 * 60_000, now), '1 小时 30 分钟');
  assert.equal(resetText(now - 60_000, now, true), '到期');
  assert.equal(resetText(now + 90 * 60_000, now, true), '1时30分');
  assert.equal(resetText(now + (2 * 86400 + 4 * 3600) * 1000, now, true), '2天4时');
  assert.equal(resetText(null, now, true), '--');
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
  assert.deepEqual(stale, { label: 'STALE · 已过期 · 1 小时前', kind: 'stale' });

  const offline = serviceState({ five: { used: 10 }, stale: true, fetchedAt: now, error: 'offline' }, now);
  assert.deepEqual(offline, { label: 'OFFLINE · 离线 · 刚刚', kind: 'error' });
  assert.deepEqual(serviceState({ windows: [] }, now), { label: '等待快照', kind: 'idle' });
  assert.deepEqual(serviceState({ windows: [], error: 'offline' }, now), { label: 'OFFLINE · 离线', kind: 'error' });
  assert.equal(ageText(null, now), '未知');
});

test('waiting agents stay neutral while active agents determine the overall state', () => {
  const waiting = { label: 'waiting', kind: 'idle' };
  const live = { label: 'live now', kind: 'live' };
  const stale = { label: 'stale 1h', kind: 'stale' };
  const offline = { label: 'offline now', kind: 'error' };

  assert.deepEqual(overallState([]), { label: '未选择 Agent', kind: 'idle' });
  assert.deepEqual(overallState([waiting]), { label: '等待快照', kind: 'idle' });
  assert.deepEqual(overallState([live, waiting]), { label: 'LIVE · 正常', kind: 'live' });
  assert.deepEqual(overallState([stale, waiting]), { label: 'STALE · 数据过期', kind: 'stale' });
  assert.deepEqual(overallState([offline, waiting]), { label: 'OFFLINE · 离线', kind: 'error' });
  assert.deepEqual(overallState([live, offline, waiting]), { label: 'OFFLINE · 部分离线', kind: 'error' });
});

test('settings choices reflect current freshness instead of historical availability', () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  assert.deepEqual(choiceState({ windows: [] }, now), { label: '等待快照', kind: 'idle' });
  assert.deepEqual(choiceState({ five: { used: 10 }, fetchedAt: now }, now), {
    label: '已连接',
    kind: 'live',
  });
  assert.deepEqual(choiceState({ five: { used: 10 }, fetchedAt: now, stale: true }, now), {
    label: '数据过期',
    kind: 'stale',
  });
  assert.deepEqual(choiceState({ five: { used: 10 }, fetchedAt: now, error: 'offline' }, now), {
    label: '离线',
    kind: 'error',
  });
});

test('offline rendering preserves last-good quota data', () => {
  const usage = {
    config: {
      alertPercent: 90,
      agents: [{ id: 'codex', label: 'Codex', defaultVisible: true }],
    },
    agents: [{
      id: 'codex',
      label: 'Codex',
      fetchedAt: 1234,
      windows: [{ id: 'seven', used: 42, resetAt: 5678 }],
      groups: [],
    }],
  };
  const result = offlineUsage(usage, usage.config.agents, new Error('temporary failure'));

  assert.equal(result.config.alertPercent, 90);
  assert.deepEqual(result.agents[0].windows, usage.agents[0].windows);
  assert.equal(result.agents[0].fetchedAt, 1234);
  assert.equal(result.agents[0].stale, true);
  assert.equal(result.agents[0].error, 'temporary failure');
});

test('overlapping refresh triggers share one request and retry after it settles', async () => {
  function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  const first = deferred();
  const second = deferred();
  const requests = [first, second];
  const events = [];
  let loadCount = 0;
  const refresh = createUsageRefresher(
    () => {
      loadCount += 1;
      return requests.shift().promise;
    },
    (usage) => events.push(['usage', usage.id]),
    (error) => events.push(['error', error.message]),
  );

  const initialRefresh = refresh();
  const overlappingRefresh = refresh();
  assert.equal(overlappingRefresh, initialRefresh);
  assert.equal(loadCount, 1);

  first.resolve({ id: 'first' });
  assert.equal(await initialRefresh, true);
  assert.deepEqual(events, [['usage', 'first']]);

  const nextRefresh = refresh();
  assert.equal(loadCount, 2);
  second.resolve({ id: 'second' });
  assert.equal(await nextRefresh, true);
  assert.deepEqual(events, [['usage', 'first'], ['usage', 'second']]);
});

test('usage polling pauses while the page is hidden and refreshes as soon as it is visible', () => {
  const listeners = new Map();
  let intervalCallback = null;
  let intervalMs = null;
  let refreshCount = 0;
  const pageDocument = {
    visibilityState: 'hidden',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const refreshWhenVisible = installUsagePolling(
    () => {
      refreshCount += 1;
    },
    pageDocument,
    (callback, delay) => {
      intervalCallback = callback;
      intervalMs = delay;
    },
  );

  assert.equal(intervalMs, 60000);
  assert.equal(intervalCallback(), false);
  assert.equal(refreshCount, 0);

  pageDocument.visibilityState = 'visible';
  assert.equal(listeners.get('visibilitychange')(), true);
  assert.equal(intervalMs, 5000);
  assert.equal(refreshCount, 1);
  assert.equal(refreshWhenVisible(), true);
  assert.equal(refreshCount, 2);
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
    density: 'strip',
  }, catalog), {
    visibleAgents: ['gemini', 'cursor'],
    density: 'strip',
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
  assert.deepEqual(resolveLayout(6, 'strip'), {
    columns: 1,
    density: 'strip',
    width: 32768,
    height: 48,
  });
  assert.deepEqual(resolveLayout(6, 'strip-mini'), {
    columns: 1,
    density: 'strip-mini',
    width: 240,
    height: 40,
  });
  assert.equal(resolveLayout(9, 'comfortable').height, 640);
  assert.equal(resolveLayout(11, 'standard').height, 640);
  assert.equal(resolveLayout(19, 'auto').height, 640);
  assert.equal(resolveLayout(32, 'auto').height, 640);
});

test('strip-mini width fits the rendered Agent content instead of the display width', () => {
  const dashboard = { getBoundingClientRect: () => ({ width: 372 }) };
  const readouts = {
    getBoundingClientRect: () => ({ width: 320 }),
    children: [
      { getBoundingClientRect: () => ({ width: 116 }) },
      { getBoundingClientRect: () => ({ width: 130 }) },
    ],
  };

  assert.equal(stripMiniContentWidth(dashboard, readouts, 240), 309);
  assert.equal(stripMiniContentWidth(dashboard, { getBoundingClientRect: () => ({ width: 320 }), children: [] }, 240), 240);
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

    resizeCalls.length = 0;
    dashboardHeight = 34;
    requestDesktopResize({ width: 480, height: 48, density: 'strip' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[480, 48]]);

    resizeCalls.length = 0;
    dashboardHeight = 34;
    requestDesktopResize({ width: 480, height: 40, density: 'strip-mini' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[480, 42]]);

    resizeCalls.length = 0;
    dashboardHeight = 40;
    requestDesktopResize({ width: 520, height: 40, density: 'strip-mini' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(resizeCalls, [[520, 42]]);
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
    if (originalDocument === undefined) delete global.document;
    else global.document = originalDocument;
  }
});

test('settings window is tall enough for built-in choices and capped for long catalogs', () => {
  assert.equal(settingsWindowHeight(0), 500);
  assert.equal(settingsWindowHeight(7), 542);
  assert.equal(settingsWindowHeight(32), 640);
});

test('main quota card keeps reset countdowns visible and legible at standard density', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  const hiddenResetRules = Array.from(stylesheet.matchAll(/([^{}]+)\{([^{}]+)\}/g))
    .filter(([, selector, body]) => selector.includes('.reset-text') && /display\s*:\s*none/.test(body))
    .map(([, selector]) => selector.trim());
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

test('localized reset countdowns wrap instead of being ellipsized in narrow cards', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');

  assert.match(stylesheet, /\.quota-copy\s*\{[^}]*flex-wrap:\s*wrap;[^}]*row-gap:\s*2px;/s);
  assert.match(stylesheet, /\.quota-copy \.window-label\s*\{[^}]*max-width:\s*100%;/s);
  assert.match(stylesheet, /\.quota-copy \.reset-text\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(stylesheet, /\.group-metric\s*\{[^}]*grid-template-columns:\s*auto auto minmax\(0,\s*1fr\);/s);
  assert.match(stylesheet, /\.group-metric \.reset-text\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
});

test('horizontal strip layout keeps all agents in one scrolling row with bar progress', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

  assert.match(markup, /input type="radio" name="density" value="strip">横向条/);
  assert.match(script, /const STRIP_REQUEST_WIDTH = 32768;/);
  assert.match(stylesheet, /\.watch\[data-density="strip"\] \{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\);/s);
  assert.match(stylesheet, /\.watch\[data-density="strip"\] \.readouts\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip"\] \.quota-ring::before\s*\{[^}]*display:\s*none;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip"\] \.quota::after\s*\{[^}]*height:\s*3px;[^}]*background:\s*linear-gradient/s);
});

test('strip-mini layout drops live/offline chips, abbreviates agent names, and thickens the bar', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

  assert.match(markup, /input type="radio" name="density" value="strip-mini">极简条/);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.state\s*\{[^}]*display:\s*none;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.overall-state\s*\{[^}]*display:\s*none;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.watch-title\s*\{[^}]*display:\s*none;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\]\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*calc\(100vw - 8px\);/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.readouts\s*\{[^}]*gap:\s*3px;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.group-label\s*\{[^}]*font-weight:\s*700;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.readout\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(script, /compact \? abbreviateGroupLabel\(fullGroupLabel\) : fullGroupLabel/);
  assert.match(script, /compact \? resetText\(windowData\.resetAt, now, true\) : resetFull/);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.quota\.is-empty\s*,\s*\.watch\[data-density="strip-mini"\] \.group-metric\.is-empty\s*\{[^}]*display:\s*none;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.service-name\.is-live \.dot\s*\{[^}]*background:\s*var\(--live\)/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.service-name\.is-error \.dot\s*\{[^}]*background:\s*var\(--alert\)/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.quota::after\s*\{[^}]*height:\s*6px;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.group-metric::after\s*\{[^}]*height:\s*6px;/s);
  assert.doesNotMatch(stylesheet, /\.watch\[data-density="strip-mini"\] \.quota::after\s*\{[^}]*box-shadow:/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\] \.empty-state\s*\{[^}]*display:\s*flex;/s);
  assert.match(stylesheet, /\.watch\[data-density="strip-mini"\]:not\(\[aria-busy="true"\]\) \.readouts:empty\s*\{[^}]*display:\s*none;/s);
  assert.match(script, /density === 'strip-mini' \? abbreviateLabel\(metadata\.id, fullLabel\) : fullLabel/);
  assert.match(script, /density === 'strip-mini' \? '等待快照' : `等待本地快照 \$\{metadata\.bridgeFile\}`/);
  assert.match(script, /name\.classList\.add\(`is-\$\{state\.kind\}`\)/);

  assert.equal(abbreviateLabel('claude', 'Claude Code'), 'CC');
  assert.equal(abbreviateLabel('codex', 'Codex'), 'CX');
  assert.equal(abbreviateLabel('unknown-agent', 'Some Tool'), 'ST');
  assert.equal(abbreviateLabel('unknown-agent', 'SoloTool'), 'SO');
  assert.equal(abbreviateGroupLabel('Gemini Models'), 'GM');
  assert.equal(abbreviateGroupLabel('Claude and GPT models'), 'CG');
  assert.equal(abbreviateGroupLabel('Fast models'), 'FM');
});

test('grouped agent cards render individual reset countdowns for each group window', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  assert.match(script, /metric\.append\(windowLabel,\s*valueNode,\s*resetNode\)/);
  // Group metrics must be able to wrap, otherwise the countdowns are clipped by
  // .readout { overflow: hidden } in the 3-column compact layout.
  assert.match(stylesheet, /\.group-metrics\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(stylesheet, /\.group-label\s*\{[^}]*min-width:\s*56px;/s);
  // Density overrides are more specific than `.group-metric .reset-text`, so the
  // compact card must restate the smaller size or it renders larger than standard.
  assert.match(stylesheet, /\[data-density="compact"\] \.group-metric \.reset-text\s*\{[^}]*font-size:\s*9\.5px;/s);
});

test('quota tooltips report the label, percentage and countdown as text', () => {
  assert.equal(quotaTitle('5H', 42, '3h 20m'), '5H 42%，重置：3h 20m');
  assert.equal(quotaTitle('7D', null, 'no reset'), '7D --，重置：no reset');
});

test('alert text keeps readable contrast without changing the progress accent', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  const darkText = stylesheet.match(/:root\s*\{[\s\S]*?--alert-text:\s*(#[0-9a-f]{6})/i)[1];
  const lightBlock = stylesheet.match(/@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/)[1];
  const lightText = lightBlock.match(/--alert-text:\s*(#[0-9a-f]{6})/i)[1];
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    const linear = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const contrast = (left, right) => {
    const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  assert.ok(contrast(darkText, '#3a3a3e') >= 4.5);
  assert.ok(contrast(lightText, '#ffffff') >= 4.5);
  assert.match(stylesheet, /\.quota-value\.is-alert\s*\{[^}]*color:\s*var\(--alert-text\)/s);
  assert.match(stylesheet, /\.quota\.is-alert\s*\{[^}]*--quota-color:\s*var\(--alert\)/s);
});

test('usage signature stays stable for identical data within the same minute', () => {
  const now = Date.UTC(2026, 7, 6, 12, 30, 15);
  const catalog = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
  const settings = { visibleAgents: ['claude', 'codex'], density: 'auto' };
  const usage = {
    agents: [
      { id: 'claude', fetchedAt: now - 5000, windows: [{ id: 'five', used: 42, resetAt: now + 3600000 }] },
      { id: 'codex', fetchedAt: now - 5000, windows: [{ id: 'five', used: 10, resetAt: now + 3600000 }] },
    ],
  };
  const first = usageSignature(usage, settings, catalog, now);
  assert.equal(usageSignature(usage, settings, catalog, now + 30_000), first);

  // refreshed timestamps with unchanged values must not bust the signature:
  // otherwise the render skip is dead code and cards flash on every poll
  const restamped = { agents: usage.agents.map((agent) => ({ ...agent, fetchedAt: now })) };
  assert.equal(usageSignature(restamped, settings, catalog, now), first);
});

test('usage signature changes when values, state or the minute bucket move', () => {
  const now = Date.UTC(2026, 7, 6, 12, 30, 15);
  const catalog = [{ id: 'claude', label: 'Claude Code' }];
  const settings = { visibleAgents: ['claude'], density: 'auto' };
  const usage = {
    agents: [{ id: 'claude', fetchedAt: now, windows: [{ id: 'five', used: 42, resetAt: now + 3600000 }] }],
  };
  const base = usageSignature(usage, settings, catalog, now);

  const bumped = { agents: [{ ...usage.agents[0], windows: [{ id: 'five', used: 43, resetAt: now + 3600000 }] }] };
  assert.notEqual(usageSignature(bumped, settings, catalog, now), base);

  const stale = { agents: [{ ...usage.agents[0], stale: true }] };
  assert.notEqual(usageSignature(stale, settings, catalog, now), base);

  assert.notEqual(usageSignature(usage, settings, catalog, now + 60_000), base);
  assert.notEqual(usageSignature(usage, { ...settings, density: 'compact' }, catalog, now), base);
  assert.notEqual(usageSignature(usage, { ...settings, density: 'strip' }, catalog, now), base);
  assert.notEqual(usageSignature(usage, settings, [...catalog, { id: 'kimi', label: 'Kimi Code' }], now), base);

  // config-level repaints: threshold, catalog labels/accents and window labels
  const thresholded = { ...usage, config: { alertPercent: 40 } };
  assert.notEqual(usageSignature(thresholded, settings, catalog, now), base);
  assert.notEqual(usageSignature(usage, settings, [{ id: 'claude', label: 'Claude' }], now), base);
  const relabeled = { agents: [{ ...usage.agents[0], windows: [{ id: 'five', label: 'Session', used: 42, resetAt: now + 3600000 }] }] };
  assert.notEqual(usageSignature(relabeled, settings, catalog, now), base);
});

test('agent signature tracks group quota values and errors', () => {
  const now = Date.UTC(2026, 7, 6, 12, 0, 0);
  const agent = {
    id: 'codex',
    fetchedAt: now,
    windows: [],
    groups: [{ label: 'GPT-5', windows: [{ id: 'five', used: 12, resetAt: now + 1000 }] }],
  };
  const base = JSON.stringify(agentSignature(agent));
  const changed = JSON.stringify(agentSignature({
    ...agent,
    groups: [{ label: 'GPT-5', windows: [{ id: 'five', used: 13, resetAt: now + 1000 }] }],
  }));
  assert.notEqual(changed, base);
  assert.notEqual(JSON.stringify(agentSignature({ ...agent, error: 'offline' })), base);
});

test('first paint shows skeleton placeholders and updates flash with motion-safe CSS', () => {
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
  assert.match(stylesheet, /\.watch\[aria-busy="true"\] \.readouts:empty::before/s);
  assert.match(stylesheet, /@keyframes skeleton-shimmer/s);
  assert.match(stylesheet, /\.readout\.is-updated \.quota-ring\s*,\s*\.readout\.is-updated \.group-metric\s*\{[^}]*animation:\s*quota-flash/s);
  const reducedMotion = stylesheet.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}\s*@media \(prefers-reduced-transparency/)[1];
  assert.match(reducedMotion, /\.readout\.is-updated \.quota-ring[\s\S]*?animation:\s*none/s);
});
