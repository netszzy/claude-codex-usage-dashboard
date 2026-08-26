'use strict';

const REFRESH_VISIBLE_MS = 5_000;
const REFRESH_HIDDEN_MS = 60_000;
const MAX_AGENTS = 3;

let latestUsage = null;
let usageEtag = null;
let lastRenderSignature = '';
let refreshTimer = null;

function dataWindows(data) {
  if (data && Array.isArray(data.windows)) return data.windows;
  return [];
}

function percentValue(windowData) {
  return windowData && Number.isFinite(windowData.used) ? Math.round(windowData.used) : null;
}

function resetText(timestamp, now = Date.now()) {
  if (!timestamp) return '--';
  const seconds = Math.floor((timestamp - now) / 1000);
  if (seconds <= 0) return '到期';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${minutes}分`;
  return `${Math.max(0, minutes)}分`;
}

function ageText(timestamp, now = Date.now()) {
  if (!timestamp) return '未知';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return '刚刚更新';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前更新`;
  return `${Math.floor(seconds / 3600)} 小时前更新`;
}

function stateKind(agent) {
  if (!agent || !dataWindows(agent).some((windowData) => percentValue(windowData) !== null)) {
    return agent && agent.error ? 'error' : 'idle';
  }
  if (agent.error) return 'error';
  return agent.stale ? 'stale' : 'live';
}

function stateText(kind) {
  return { live: 'LIVE', stale: 'STALE', error: 'OFFLINE', idle: '等待数据' }[kind] || '等待数据';
}

function quotaLevel(value, alertPercent) {
  if (value === null) return 'normal';
  if (value >= alertPercent) return 'alert';
  if (value >= 50) return 'warning';
  return 'normal';
}

function usableWindows(data) {
  return dataWindows(data).filter((windowData) => percentValue(windowData) !== null);
}

function sameWindows(left, right) {
  return left.length === right.length && left.every((windowData, index) => {
    const other = right[index];
    return other
      && windowData.label === other.label
      && windowData.used === other.used
      && windowData.resetAt === other.resetAt;
  });
}

function displaySections(agent) {
  const topLevel = usableWindows(agent);
  const groups = Array.isArray(agent && agent.groups) ? agent.groups : [];
  const sections = groups.map((group) => ({
    label: group.label || '模型组',
    windows: usableWindows(group),
  })).filter((group) => group.windows.length);
  if (!sections.length) return topLevel.length ? [{ label: '', windows: topLevel }] : [];
  if (topLevel.length && !sections.some((group) => sameWindows(group.windows, topLevel))) {
    sections.unshift({ label: '总览', windows: topLevel });
  }
  return sections;
}

function displayWindows(agent) {
  return displaySections(agent).flatMap((section) => section.windows.map((windowData) => ({
    ...windowData,
    label: section.label ? `${section.label} · ${windowData.label || windowData.id || ''}` : windowData.label,
  })));
}

function phoneAgents(usage) {
  const agents = Array.isArray(usage && usage.agents) ? usage.agents : [];
  const configured = usage && usage.config && Array.isArray(usage.config.visibleAgents)
    ? usage.config.visibleAgents
    : null;
  if (configured) {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    return configured.map((id) => byId.get(id)).filter(Boolean);
  }
  const catalog = usage && usage.config && Array.isArray(usage.config.agents) ? usage.config.agents : [];
  const defaults = new Set(catalog.filter((agent) => agent.defaultVisible).map((agent) => agent.id));
  const selected = defaults.size ? agents.filter((agent) => defaults.has(agent.id)) : agents;
  return selected.slice(0, MAX_AGENTS);
}

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMetric(windowData, alertPercent, now) {
  const value = percentValue(windowData);
  const level = quotaLevel(value, alertPercent);
  const metric = element('div', `phone-metric is-${level}`);
  const top = element('div', 'metric-top');
  const label = element('span', 'metric-label', windowData.label || String(windowData.id || '额度').toUpperCase());
  const valueNode = element('strong', 'metric-value', value === null ? '--' : `${value}%`);
  const reset = element('span', 'metric-reset');
  reset.append(
    document.createTextNode('重置 '),
    element('strong', 'metric-reset-time', resetText(windowData.resetAt, now)),
  );
  const bar = element('span', 'metric-bar');
  const fill = element('i');
  fill.style.setProperty('--progress', `${Math.max(0, Math.min(100, value || 0))}%`);
  bar.append(fill);
  top.append(label, valueNode);
  metric.append(top, reset, bar);
  return metric;
}

function renderMetrics(windows, alertPercent, now) {
  const metrics = element('div', 'phone-metrics');
  for (const windowData of windows) metrics.append(renderMetric(windowData, alertPercent, now));
  return metrics;
}

function renderGroup(section, alertPercent, now) {
  const group = element('section', 'phone-group');
  group.append(element('h2', 'phone-group-title', section.label));
  group.append(renderMetrics(section.windows, alertPercent, now));
  return group;
}

function usageSignature(usage, now) {
  return JSON.stringify({
    minute: Math.floor(now / 60_000),
    alert: usage && usage.config && usage.config.alertPercent,
    agents: phoneAgents(usage).map((agent) => ({
      id: agent.id,
      label: agent.label,
      accent: agent.accent,
      stale: agent.stale,
      error: agent.error,
      fetchedAt: agent.fetchedAt,
      sections: displaySections(agent).map((section) => [
        section.label,
        section.windows.map((windowData) => [windowData.label, windowData.used, windowData.resetAt]),
      ]),
    })),
  });
}

function renderUsage(usage, now = Date.now()) {
  const signature = usageSignature(usage, now);
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;
  const readouts = document.getElementById('phone_readouts');
  const empty = document.getElementById('phone_empty');
  const alertPercent = Number.isFinite(usage && usage.config && usage.config.alertPercent)
    ? usage.config.alertPercent
    : 85;
  const agents = phoneAgents(usage);
  readouts.textContent = '';
  for (const agent of agents) {
    const kind = stateKind(agent);
    const card = element('article', `phone-card is-${kind}`);
    card.style.setProperty('--agent-accent', agent.accent || '#0a84ff');
    const head = element('header', 'phone-card-head');
    const name = element('span', 'service-name');
    name.append(element('i', 'service-dot'), document.createTextNode(agent.label || agent.id || 'Agent'));
    head.append(name, element('span', 'service-state', stateText(kind)));
    card.append(head);
    const sections = displaySections(agent);
    if (sections.length) {
      if (sections.length === 1 && !sections[0].label) {
        card.append(renderMetrics(sections[0].windows, alertPercent, now));
      } else {
        card.classList.add('has-groups');
        const groups = element('div', 'phone-groups');
        for (const section of sections) groups.append(renderGroup(section, alertPercent, now));
        card.append(groups);
      }
    } else {
      card.append(element('p', 'phone-no-data', kind === 'error' ? '本机数据源不可用' : '等待本机额度数据'));
    }
    readouts.append(card);
  }
  empty.hidden = agents.length > 0;
  document.getElementById('phone_updated').textContent = ageText(
    Math.max(0, ...agents.map((agent) => Number(agent.fetchedAt) || 0)),
    now,
  );
}

function setPhoneState(kind, text) {
  const state = document.getElementById('phone_state');
  state.className = `phone-state is-${kind}`;
  state.textContent = text;
}

async function refreshUsage() {
  try {
    const headers = usageEtag ? { 'If-None-Match': usageEtag } : {};
    const response = await fetch('./api/usage', { cache: 'no-store', headers });
    if (response.status === 304) {
      if (latestUsage) renderUsage(latestUsage);
      setPhoneState('live', 'LIVE');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    usageEtag = response.headers.get('etag') || null;
    latestUsage = await response.json();
    renderUsage(latestUsage);
    const hasProblem = phoneAgents(latestUsage).some((agent) => stateKind(agent) === 'error');
    const hasStale = phoneAgents(latestUsage).some((agent) => stateKind(agent) === 'stale');
    setPhoneState(hasProblem ? 'error' : hasStale ? 'stale' : 'live', hasProblem ? '部分离线' : hasStale ? '数据过期' : 'LIVE');
  } catch {
    if (latestUsage) renderUsage(latestUsage);
    setPhoneState('error', '连接已断开');
  }
}

function resetRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(
    () => { if (document.visibilityState === 'visible') refreshUsage(); },
    document.visibilityState === 'visible' ? REFRESH_VISIBLE_MS : REFRESH_HIDDEN_MS,
  );
}

function init() {
  refreshUsage();
  resetRefreshTimer();
  setInterval(() => { if (latestUsage && document.visibilityState === 'visible') renderUsage(latestUsage); }, 30_000);
  document.addEventListener('visibilitychange', () => {
    resetRefreshTimer();
    if (document.visibilityState === 'visible') refreshUsage();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REFRESH_VISIBLE_MS, displaySections, displayWindows, phoneAgents, resetText };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') init();
