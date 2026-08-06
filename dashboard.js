'use strict';

const DEFAULT_ALERT_PERCENT = 85;
const MAX_HUD_HEIGHT = 640;
const SETTINGS_MIN_WIDTH = 480;
const SETTINGS_KEY = 'usage-watch.settings.v1';
const DENSITIES = new Set(['auto', 'compact', 'comfortable']);
const LEGACY_AGENTS = [
  { id: 'claude', label: 'Claude Code', accent: '#d99a5d', defaultVisible: true, source: 'statusline-cache' },
  { id: 'codex', label: 'Codex', accent: '#67bdb4', defaultVisible: true, source: 'codex-sessions' },
  { id: 'antigravity', label: 'Antigravity', accent: '#9fbd69', defaultVisible: true, source: 'antigravity-grpc' },
];

let latestUsage = null;
let lastGoodUsage = null;
let currentCatalog = LEGACY_AGENTS;
let currentSettings = null;
let settingsOpen = false;
let settingsClosing = false;
let settingsCloseTimer = null;
let resizeTimer = null;
let lastResizeRequest = '';
let lastResizeWidth = null;
let settingsReturnFocus = null;
let lastRenderSignature = null;
let previousCardSignatures = new Map();

function percentValue(windowData) {
  return windowData && typeof windowData.used === 'number' && Number.isFinite(windowData.used)
    ? Math.round(windowData.used)
    : null;
}

function ageText(timestamp, now = Date.now()) {
  if (!timestamp) return 'unknown age';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function resetText(timestamp, now = Date.now()) {
  if (!timestamp) return 'no reset';
  const seconds = Math.floor((timestamp - now) / 1000);
  if (seconds <= 0) return 'expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(0, minutes)}m`;
}

function quotaLevel(value, alertPercent = DEFAULT_ALERT_PERCENT) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'normal';
  if (value >= alertPercent) return 'alert';
  if (value >= 50) return 'warning';
  return 'normal';
}

function dataWindows(data) {
  if (data && Array.isArray(data.windows)) return data.windows;
  if (!data) return [];
  return [data.five, data.seven].filter(Boolean);
}

function hasUsageData(data) {
  if (dataWindows(data).some((windowData) => percentValue(windowData) !== null)) return true;
  return Boolean(data && Array.isArray(data.groups) && data.groups.some((group) => (
    dataWindows(group).some((windowData) => percentValue(windowData) !== null)
  )));
}

function serviceState(data, now = Date.now()) {
  if (!data || !hasUsageData(data)) {
    return data && data.error
      ? { label: 'offline', kind: 'error' }
      : { label: 'waiting', kind: 'idle' };
  }
  const age = ageText(data.fetchedAt, now);
  if (data.error) return { label: `offline ${age}`, kind: 'error' };
  if (data.stale) return { label: `stale ${age}`, kind: 'stale' };
  return { label: `live ${age}`, kind: 'live' };
}

function overallState(states) {
  if (!states.length) return { label: 'no agents', kind: 'idle' };
  const activeStates = states.filter((state) => state.kind !== 'idle');
  if (!activeStates.length) return { label: 'waiting', kind: 'idle' };
  const hasError = activeStates.some((state) => state.kind === 'error');
  const hasStale = activeStates.some((state) => state.kind === 'stale');
  if (hasError) {
    return {
      label: activeStates.every((state) => state.kind === 'error') ? 'offline' : 'degraded',
      kind: 'error',
    };
  }
  if (hasStale) return { label: 'stale data', kind: 'stale' };
  return { label: 'live', kind: 'live' };
}

function choiceState(data, now = Date.now()) {
  const state = serviceState(data, now);
  const labels = {
    idle: '等待快照',
    live: '已连接',
    stale: '数据过期',
    error: '离线',
  };
  return { label: labels[state.kind], kind: state.kind };
}

function normalizeSettings(raw, catalog = LEGACY_AGENTS) {
  const availableIds = new Set(catalog.map((agent) => agent.id));
  const defaults = catalog.filter((agent) => agent.defaultVisible).map((agent) => agent.id);
  const visibleAgents = raw && Array.isArray(raw.visibleAgents)
    ? raw.visibleAgents.filter((id, index, values) => availableIds.has(id) && values.indexOf(id) === index)
    : defaults;
  const density = raw && DENSITIES.has(raw.density) ? raw.density : 'auto';
  return { visibleAgents, density };
}

function resolveLayout(agentCount, density = 'auto', wideSingleCard = false) {
  const resolvedDensity = density === 'auto'
    ? agentCount >= 5 ? 'compact' : 'standard'
    : density;
  let columns = 1;
  if (agentCount >= 2) columns = 2;
  if (resolvedDensity === 'compact' && agentCount >= 5) columns = 3;
  const cardHeight = resolvedDensity === 'compact' ? 96 : resolvedDensity === 'comfortable' ? 126 : 108;
  const rows = Math.max(1, Math.ceil(Math.max(agentCount, 1) / columns));
  const singleAgentWidth = wideSingleCard || resolvedDensity === 'comfortable' ? 320 : 240;
  const naturalHeight = 68 + rows * cardHeight + Math.max(0, rows - 1) * 6;
  return {
    columns,
    density: resolvedDensity,
    width: agentCount === 1 ? singleAgentWidth : columns === 3 ? 600 : columns === 2 && resolvedDensity === 'comfortable' ? 500 : 380,
    height: Math.min(MAX_HUD_HEIGHT, naturalHeight),
  };
}

function catalogFromUsage(usage) {
  const catalog = usage && usage.config && Array.isArray(usage.config.agents)
    ? usage.config.agents
    : LEGACY_AGENTS;
  return catalog.filter((agent) => agent && typeof agent.id === 'string' && typeof agent.label === 'string');
}

function agentsFromUsage(usage) {
  if (usage && Array.isArray(usage.agents)) return usage.agents;
  return LEGACY_AGENTS.map((metadata) => ({
    ...metadata,
    ...(usage && usage[metadata.id] ? usage[metadata.id] : {}),
    windows: [
      { id: 'five', label: '5H', ...((usage && usage[metadata.id] && usage[metadata.id].five) || {}) },
      { id: 'seven', label: '7D', ...((usage && usage[metadata.id] && usage[metadata.id].seven) || {}) },
    ],
  }));
}

function windowDataSignature(windows) {
  return windows.map((windowData) => [
    windowData.label || windowData.id || '',
    percentValue(windowData),
    windowData.resetAt || 0,
  ]);
}

// ponytail: fetchedAt is deliberately unsigned — age labels stay fresh via the
// minute bucket in usageSignature, and signing it would re-render (and flash)
// on every upstream refresh even when nothing visible changed.
function agentSignature(agent) {
  return [
    agent.id,
    agent.label || '',
    agent.accent || '',
    agent.error || '',
    agent.stale ? 1 : 0,
    windowDataSignature(dataWindows(agent)),
    Array.isArray(agent.groups)
      ? agent.groups.map((group) => [group.label || '', windowDataSignature(dataWindows(group))])
      : [],
  ];
}

function usageSignature(usage, settings, catalog, now = Date.now()) {
  return JSON.stringify({
    minute: Math.floor(now / 60000),
    alert: usage && usage.config && typeof usage.config.alertPercent === 'number'
      ? usage.config.alertPercent
      : null,
    settings,
    catalog: catalog.map((agent) => [agent.id, agent.label || '', agent.accent || '', agent.bridgeFile || '']),
    agents: agentsFromUsage(usage).map(agentSignature),
  });
}

function offlineUsage(usage, catalog, error) {
  const base = usage && typeof usage === 'object' ? usage : {};
  const message = error && error.message ? error.message : 'Dashboard service offline';
  const byId = new Map(agentsFromUsage(base).map((agent) => [agent.id, agent]));
  const agents = catalog.map((metadata) => {
    const previous = byId.get(metadata.id);
    if (previous && hasUsageData(previous)) {
      return { ...previous, stale: true, error: message };
    }
    return {
      ...metadata,
      fetchedAt: null,
      stale: true,
      error: message,
      windows: [],
      groups: [],
    };
  });
  return {
    ...base,
    config: {
      ...(base.config && typeof base.config === 'object' ? base.config : {}),
      agents: catalog,
    },
    agents,
  };
}

function createUsageRefresher(loadUsage, onUsage, onError) {
  let inFlight = null;
  return function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const usage = await loadUsage();
        onUsage(usage);
        return true;
      } catch (error) {
        onError(error);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

function installUsagePolling(refresh, pageDocument = document, setIntervalFn = setInterval) {
  const refreshWhenVisible = () => {
    if (pageDocument.visibilityState !== 'visible') return false;
    refresh();
    return true;
  };
  setIntervalFn(refreshWhenVisible, 5000);
  pageDocument.addEventListener('visibilitychange', refreshWhenVisible);
  return refreshWhenVisible;
}

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function quotaValueElement(windowData, alertPercent) {
  const value = percentValue(windowData);
  const valueNode = element('strong', 'quota-value', value === null ? '--' : `${value}%`);
  const level = quotaLevel(value, alertPercent);
  if (level !== 'normal') valueNode.classList.add(`is-${level}`);
  return { level, value, valueNode };
}

function quotaTitle(labelText, value, resetLabel) {
  return `${labelText} ${value === null ? '--' : `${value}%`}, reset ${resetLabel}`;
}

function quotaGrid(windows, alertPercent, now) {
  const grid = element('div', 'quota-grid');
  for (const windowData of windows.slice(0, 4)) {
    const quota = element('div', 'quota');
    const ring = element('span', 'quota-ring');
    const copy = element('span', 'quota-copy');
    const labelText = windowData.label || String(windowData.id || 'quota').toUpperCase();
    const label = element('span', 'window-label', labelText);
    const { level, value, valueNode } = quotaValueElement(windowData, alertPercent);
    const resetLabel = resetText(windowData.resetAt, now);
    const reset = element('span', 'reset-text', resetLabel);
    reset.setAttribute('aria-label', `reset ${resetLabel}`);
    const progress = value === null ? 0 : Math.max(0, Math.min(100, value));
    quota.title = quotaTitle(labelText, value, resetLabel);
    ring.style.setProperty('--quota-progress', `${progress}%`);
    ring.append(valueNode);
    copy.append(label, reset);
    quota.classList.add(`is-${level}`);
    if (value === null) quota.classList.add('is-empty');
    quota.append(ring, copy);
    grid.append(quota);
  }
  return grid;
}

function groupList(groups, alertPercent, now) {
  const list = element('div', 'group-list');
  for (const group of groups.slice(0, 4)) {
    const row = element('div', 'group-row');
    const label = element('span', 'group-label', group.label || 'Group');
    const metrics = element('span', 'group-metrics');
    for (const windowData of dataWindows(group).slice(0, 3)) {
      const metric = element('span', 'group-metric');
      const labelText = windowData.label || String(windowData.id || '').toUpperCase();
      const windowLabel = element('span', 'window-label', labelText);
      const { level, value, valueNode } = quotaValueElement(windowData, alertPercent);
      const progress = value === null ? 0 : Math.max(0, Math.min(100, value));
      const resetLabel = resetText(windowData.resetAt, now);
      const resetNode = element('span', 'reset-text', resetLabel);
      resetNode.setAttribute('aria-label', `reset ${resetLabel}`);
      metric.classList.add(`is-${level}`);
      if (value === null) metric.classList.add('is-empty');
      metric.style.setProperty('--quota-progress', `${progress}%`);
      metric.title = quotaTitle(labelText, value, resetLabel);
      metric.append(windowLabel, valueNode, resetNode);
      metrics.append(metric);
    }
    row.append(label, metrics);
    list.append(row);
  }
  return list;
}

function renderAgentCard(agent, metadata, alertPercent, now) {
  const card = element('article', 'readout');
  card.id = `card_${agent.id}`;
  card.style.setProperty('--agent-accent', agent.accent || metadata.accent || '#8ca0b3');

  const header = element('header', 'readout-head');
  const name = element('span', 'service-name');
  name.id = `label_${agent.id}`;
  name.append(element('i', 'dot'), document.createTextNode(agent.label || metadata.label));
  const state = serviceState(agent, now);
  const stateNode = element('span', `state is-${state.kind}`, state.label);
  stateNode.title = agent.error || '';
  header.append(name, stateNode);
  card.append(header);

  const groups = Array.isArray(agent.groups) ? agent.groups.filter((group) => hasUsageData(group)) : [];
  const windows = dataWindows(agent);
  const hasTopLevelUsage = windows.some((windowData) => percentValue(windowData) !== null);
  if (groups.length && (groups.length > 1 || !hasTopLevelUsage)) {
    card.classList.add('has-groups');
    card.append(groupList(groups, alertPercent, now));
  } else if (windows.length) {
    card.append(quotaGrid(windows, alertPercent, now));
  } else {
    const message = metadata.bridgeFile
      ? `等待本地快照 ${metadata.bridgeFile}`
      : '等待 Agent 产生额度数据';
    card.append(element('span', 'no-quota', message));
  }

  const values = (groups.length && (groups.length > 1 || !hasTopLevelUsage) ? groups.flatMap(dataWindows) : windows)
    .map((windowData) => (
      `${windowData.label || windowData.id} ${percentValue(windowData) ?? 'unavailable'} percent, `
      + `reset ${resetText(windowData.resetAt, now)}`
    ))
    .join('. ');
  card.setAttribute('aria-label', `${agent.label || metadata.label} usage. ${values}. ${state.label}.`);
  return { card, state };
}

function renderOverall(states) {
  const overall = document.getElementById('overall_state');
  if (!overall) return;
  const { label, kind } = overallState(states);
  const className = `overall-state is-${kind}`;
  if (overall.className !== className) overall.className = className;
  if (overall.textContent !== label) overall.textContent = label;
}

function readSavedSettings(catalog) {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'), catalog);
  } catch {
    return normalizeSettings(null, catalog);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
  } catch {}
}

function settingsWindowHeight(agentCount) {
  const rows = Math.ceil(Math.max(0, agentCount) / 2);
  return Math.min(600, Math.max(420, 290 + rows * 43));
}

function sendDesktopResize(width, height) {
  const requestKey = `${width}x${height}`;
  if (requestKey === lastResizeRequest) return;
  lastResizeRequest = requestKey;
  lastResizeWidth = width;
  window.desktopHud.resize(width, height);
}

function requestDesktopResize(layout) {
  if (!window.desktopHud || typeof window.desktopHud.resize !== 'function') return;
  if (resizeTimer) clearTimeout(resizeTimer);
  if (settingsOpen) {
    resizeTimer = null;
    sendDesktopResize(Math.max(SETTINGS_MIN_WIDTH, layout.width), settingsWindowHeight(currentCatalog.length));
    return;
  }
  if (settingsClosing) return;

  const dashboard = document.getElementById('dashboard');
  const preserveScrollableHeight = Boolean(
    dashboard
    && dashboard.classList.contains('is-scrollable')
    && layout.height < MAX_HUD_HEIGHT,
  );
  if (lastResizeWidth !== layout.width || layout.height === MAX_HUD_HEIGHT) {
    sendDesktopResize(layout.width, preserveScrollableHeight ? MAX_HUD_HEIGHT : layout.height);
  }
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    if (settingsOpen) return;
    if (!dashboard) return;
    if (layout.height === MAX_HUD_HEIGHT) {
      dashboard.classList.add('is-scrollable');
      sendDesktopResize(layout.width, MAX_HUD_HEIGHT);
      return;
    }
    const readouts = document.getElementById('readouts');
    const readoutsScrollTop = readouts ? readouts.scrollTop : 0;
    if (dashboard.classList.contains('is-scrollable')) {
      dashboard.classList.remove('is-scrollable');
    }

    let measuredHeight = Math.ceil(dashboard.getBoundingClientRect().height + 8);
    if (measuredHeight >= MAX_HUD_HEIGHT) {
      dashboard.classList.add('is-scrollable');
      if (readouts) readouts.scrollTop = readoutsScrollTop;
      measuredHeight = MAX_HUD_HEIGHT;
    }
    sendDesktopResize(layout.width, Math.max(120, measuredHeight));
  }, 80);
}

function applyLayout(agentCount) {
  const dashboard = document.getElementById('dashboard');
  const readouts = document.getElementById('readouts');
  const wideSingleCard = agentCount === 1 && Boolean(readouts.querySelector('.readout.has-groups'));
  const layout = resolveLayout(agentCount, currentSettings.density, wideSingleCard);
  dashboard.dataset.density = layout.density;
  dashboard.classList.toggle(
    'is-single-narrow',
    agentCount === 1 && !wideSingleCard && layout.density !== 'comfortable',
  );
  if (layout.height === MAX_HUD_HEIGHT) dashboard.classList.add('is-scrollable');
  readouts.className = `readouts columns-${layout.columns}`;
  requestDesktopResize(layout);
}

function renderUsage(usage, now = Date.now()) {
  latestUsage = usage;
  const nextCatalog = catalogFromUsage(usage);
  const catalogChanged = nextCatalog.map((agent) => agent.id).join('|') !== currentCatalog.map((agent) => agent.id).join('|');
  currentCatalog = nextCatalog;
  if (!currentSettings || catalogChanged) currentSettings = readSavedSettings(currentCatalog);

  const dashboard = document.getElementById('dashboard');
  dashboard.setAttribute('aria-busy', 'false');

  // ponytail: full DOM rebuilds every 5s poll waste layout work; data only moves
  // when a source refreshes, so rebuild on signature change (minute bucket keeps
  // age/reset labels ticking). Upgrade path: persistent DOM diffing.
  const signature = usageSignature(usage, currentSettings, currentCatalog, now);
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;

  const alertPercent = usage && usage.config && typeof usage.config.alertPercent === 'number'
    ? usage.config.alertPercent
    : DEFAULT_ALERT_PERCENT;
  const byId = new Map(agentsFromUsage(usage).map((agent) => [agent.id, agent]));
  const catalogById = new Map(currentCatalog.map((agent) => [agent.id, agent]));
  const readouts = document.getElementById('readouts');
  const states = [];
  const cards = [];
  const nextCardSignatures = new Map();
  for (const id of currentSettings.visibleAgents) {
    const metadata = catalogById.get(id);
    if (!metadata) continue;
    const agent = byId.get(id) || {
      ...metadata,
      fetchedAt: null,
      stale: true,
      windows: [],
      groups: [],
    };
    const rendered = renderAgentCard(agent, metadata, alertPercent, now);
    const cardSignature = JSON.stringify(agentSignature(agent));
    if (previousCardSignatures.get(id) && previousCardSignatures.get(id) !== cardSignature) {
      rendered.card.classList.add('is-updated');
    }
    nextCardSignatures.set(id, cardSignature);
    cards.push(rendered.card);
    states.push(rendered.state);
  }
  previousCardSignatures = nextCardSignatures;
  readouts.replaceChildren(...cards);
  const emptyState = document.getElementById('empty_state');
  emptyState.hidden = cards.length > 0;
  renderOverall(states);
  if (settingsOpen) renderSettingsChoices(now);
  applyLayout(cards.length);
}

function renderOffline(error) {
  renderUsage(offlineUsage(lastGoodUsage, currentCatalog, error));
}

const refreshUsage = createUsageRefresher(
  async () => {
    const response = await fetch('/api/usage', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Usage API returned ${response.status}`);
    return response.json();
  },
  (usage) => {
    lastGoodUsage = usage;
    renderUsage(usage);
  },
  renderOffline,
);

function renderSettingsChoices(now = Date.now()) {
  const choices = document.getElementById('agent_choices');
  if (!choices || !currentSettings) return;
  const panel = document.getElementById('settings_panel');
  const scrollTop = panel ? panel.scrollTop : 0;
  const activeChoice = settingsOpen && document.activeElement && document.activeElement.matches('.agent-choice input')
    ? document.activeElement.value
    : null;
  const agentDataById = new Map(agentsFromUsage(latestUsage || {}).map((agent) => [agent.id, agent]));
  const selected = new Set(currentSettings.visibleAgents);
  const nodes = currentCatalog.map((agent) => {
    const label = element('label', 'agent-choice');
    label.style.setProperty('--agent-accent', agent.accent || '#8ca0b3');
    const input = element('input');
    input.type = 'checkbox';
    input.value = agent.id;
    input.checked = selected.has(agent.id);
    input.addEventListener('change', () => {
      const next = new Set(currentSettings.visibleAgents);
      if (input.checked) next.add(agent.id);
      else next.delete(agent.id);
      currentSettings.visibleAgents = currentCatalog.map((item) => item.id).filter((id) => next.has(id));
      saveSettings();
      renderUsage(latestUsage || {});
    });
    const copy = element('span', 'choice-copy');
    const name = element('strong', '', agent.label);
    const connection = choiceState(agentDataById.get(agent.id), now);
    const status = element('span', `is-${connection.kind}`, connection.label);
    copy.append(name, status);
    label.append(input, copy);
    return label;
  });
  choices.replaceChildren(...nodes);
  if (activeChoice) {
    const replacement = Array.from(choices.querySelectorAll('input')).find((input) => input.value === activeChoice);
    if (replacement) replacement.focus({ preventScroll: true });
    else if (settingsOpen) document.getElementById('settings_close').focus({ preventScroll: true });
  }
  if (panel) panel.scrollTop = scrollTop;

  const density = document.querySelector(`input[name="density"][value="${currentSettings.density}"]`);
  if (density) density.checked = true;
}

function setSettingsOpen(open) {
  if (settingsCloseTimer) {
    clearTimeout(settingsCloseTimer);
    settingsCloseTimer = null;
  }
  settingsOpen = Boolean(open);
  settingsClosing = !settingsOpen;
  const dashboard = document.getElementById('dashboard');
  const panel = document.getElementById('settings_panel');
  const toggle = document.getElementById('settings_toggle');
  const background = [
    document.querySelector('.watch-head'),
    document.getElementById('readouts'),
    document.getElementById('empty_state'),
  ].filter(Boolean);
  if (settingsOpen) settingsReturnFocus = document.activeElement;
  dashboard.classList.toggle('is-settings-open', settingsOpen);
  for (const node of background) node.inert = settingsOpen;
  panel.inert = !settingsOpen;
  panel.setAttribute('aria-hidden', String(!settingsOpen));
  toggle.setAttribute('aria-expanded', String(settingsOpen));
  toggle.setAttribute('aria-label', settingsOpen ? '关闭显示设置' : '打开显示设置');
  toggle.title = settingsOpen ? '关闭显示设置' : '打开显示设置';
  if (settingsOpen) {
    settingsClosing = false;
    renderSettingsChoices();
    applyLayout(currentSettings ? currentSettings.visibleAgents.length : 0);
    document.getElementById('settings_close').focus();
  } else {
    const closeDelay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 150 : 310;
    settingsCloseTimer = setTimeout(() => {
      settingsCloseTimer = null;
      if (settingsOpen) return;
      settingsClosing = false;
      applyLayout(currentSettings ? currentSettings.visibleAgents.length : 0);
    }, closeDelay);
    const returnTarget = settingsReturnFocus && settingsReturnFocus.isConnected && !settingsReturnFocus.closest('[hidden]')
      ? settingsReturnFocus
      : toggle;
    settingsReturnFocus = null;
    returnTarget.focus();
  }
}

function installSettings() {
  document.getElementById('settings_toggle').addEventListener('click', () => setSettingsOpen(!settingsOpen));
  document.getElementById('empty_settings').addEventListener('click', () => setSettingsOpen(true));
  document.getElementById('settings_close').addEventListener('click', () => setSettingsOpen(false));
  document.getElementById('settings_reset').addEventListener('click', () => {
    currentSettings = normalizeSettings(null, currentCatalog);
    saveSettings();
    renderUsage(latestUsage || {});
  });
  for (const input of document.querySelectorAll('input[name="density"]')) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      currentSettings.density = input.value;
      saveSettings();
      renderUsage(latestUsage || {});
    });
  }
  document.addEventListener('keydown', (event) => {
    if (!settingsOpen) return;
    if (event.key === 'Escape') {
      setSettingsOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = document.getElementById('settings_panel');
    const focusable = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled])'))
      .filter((node) => node.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!panel.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  });
}

function installDesktopDrag() {
  const params = new URLSearchParams(window.location.search);
  const isDesktopShell = params.get('mode') === 'desktop' || /\bElectron\//.test(navigator.userAgent);
  if (!isDesktopShell) return;
  document.documentElement.classList.add('desktop-shell');
  document.body.classList.add('desktop-shell');
  if (!window.desktopHud) return;

  const watch = document.getElementById('dashboard');
  let pointerId = null;
  const stop = () => {
    if (pointerId === null) return;
    pointerId = null;
    window.desktopHud.endDrag();
  };

  watch.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, input, label, [data-no-drag]')) return;
    if (event.target.closest('.watch.is-scrollable .readouts')) return;
    pointerId = event.pointerId;
    watch.setPointerCapture(pointerId);
    window.desktopHud.beginDrag(event.screenX, event.screenY);
    event.preventDefault();
  });
  watch.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return;
    window.desktopHud.dragTo(event.screenX, event.screenY);
  });
  watch.addEventListener('pointerup', stop);
  watch.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
}

function init() {
  currentSettings = readSavedSettings(currentCatalog);
  installDesktopDrag();
  installSettings();
  refreshUsage();
  installUsagePolling(refreshUsage);
}

if (typeof module !== 'undefined' && module.exports) {
module.exports = {
  ageText,
  agentSignature,
  choiceState,
  createUsageRefresher,
  installUsagePolling,
  normalizeSettings,
  offlineUsage,
  overallState,
  percentValue,
  quotaLevel,
  quotaTitle,
  resetText,
  requestDesktopResize,
  resolveLayout,
  settingsWindowHeight,
  serviceState,
  usageSignature,
};
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();
