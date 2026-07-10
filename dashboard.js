'use strict';

const DEFAULT_ALERT_PERCENT = 85;

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
  if (!timestamp) return 'no data';
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

function serviceState(data, now = Date.now()) {
  if (!data || (!data.five && !data.seven)) {
    return { label: data && data.error ? 'offline' : 'no data', kind: 'error' };
  }
  const age = ageText(data.fetchedAt, now);
  if (data.error) return { label: `offline ${age}`, kind: 'error' };
  if (data.stale) return { label: `stale ${age}`, kind: 'stale' };
  return { label: `live ${age}`, kind: 'live' };
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function renderQuota(id, windowData, alertPercent) {
  const element = document.getElementById(id);
  if (!element) return null;
  const value = percentValue(windowData);
  element.textContent = value === null ? '--' : `${value}%`;
  const level = quotaLevel(value, alertPercent);
  element.classList.toggle('is-warning', level === 'warning');
  element.classList.toggle('is-alert', level === 'alert');
  return value;
}

function renderState(name, data, now = Date.now()) {
  const state = serviceState(data, now);
  const element = document.getElementById(`state_${name}`);
  if (element) {
    element.textContent = state.label;
    element.classList.toggle('is-live', state.kind === 'live');
    element.classList.toggle('is-stale', state.kind === 'stale');
    element.classList.toggle('is-error', state.kind === 'error');
    element.title = data && data.error ? data.error : '';
  }
  return state;
}

function renderService(name, label, data, alertPercent, now = Date.now()) {
  const five = renderQuota(`value_${name}_five`, data && data.five, alertPercent);
  const seven = renderQuota(`value_${name}_seven`, data && data.seven, alertPercent);
  setText(`reset_${name}_five`, resetText(data && data.five && data.five.resetAt, now));
  setText(`reset_${name}_seven`, resetText(data && data.seven && data.seven.resetAt, now));
  const state = renderState(name, data, now);
  const card = document.getElementById(`card_${name}`);
  if (card) {
    card.setAttribute(
      'aria-label',
      `${label} usage. 5 hour ${five === null ? 'unavailable' : `${five} percent`}. `
        + `7 day ${seven === null ? 'unavailable' : `${seven} percent`}. ${state.label}.`,
    );
  }
  return state;
}

function renderAntigravity(data, alertPercent, now = Date.now()) {
  const primaryLabel = data && (data.activeLabel || data.model) ? data.activeLabel || data.model : 'active group';
  setText('label_antigravity_primary', primaryLabel);
  const five = renderQuota('value_antigravity_five', data && data.five, alertPercent);
  const seven = renderQuota('value_antigravity_seven', data && data.seven, alertPercent);
  setText('reset_antigravity_five', resetText(data && data.five && data.five.resetAt, now));
  setText('reset_antigravity_seven', resetText(data && data.seven && data.seven.resetAt, now));

  const otherRow = document.getElementById('antigravity_other');
  const other = data && data.other;
  if (otherRow) otherRow.hidden = !other;
  if (other) {
    setText('label_antigravity_other', other.label || 'other group');
    renderQuota('value_antigravity_other_five', other.five, alertPercent);
    renderQuota('value_antigravity_other_seven', other.seven, alertPercent);
  }

  const state = renderState('antigravity', data, now);
  const card = document.getElementById('card_antigravity');
  if (card) {
    card.setAttribute(
      'aria-label',
      `Antigravity ${primaryLabel}. 5 hour ${five === null ? 'unavailable' : `${five} percent`}. `
        + `7 day ${seven === null ? 'unavailable' : `${seven} percent`}. ${state.label}.`,
    );
  }
  return state;
}

function renderOverall(states) {
  const element = document.getElementById('overall_state');
  if (!element) return;
  const hasError = states.some((state) => state.kind === 'error');
  const hasStale = states.some((state) => state.kind === 'stale');
  const kind = hasError ? 'error' : hasStale ? 'stale' : 'live';
  element.textContent = hasError ? 'degraded' : hasStale ? 'stale data' : 'live';
  element.classList.toggle('is-live', kind === 'live');
  element.classList.toggle('is-stale', kind === 'stale');
  element.classList.toggle('is-error', kind === 'error');
}

function renderUsage(usage, now = Date.now()) {
  const alertPercent = usage && usage.config && typeof usage.config.alertPercent === 'number'
    ? usage.config.alertPercent
    : DEFAULT_ALERT_PERCENT;
  const states = [
    renderService('claude', 'Claude', usage && usage.claude ? usage.claude : {}, alertPercent, now),
    renderService('codex', 'Codex', usage && usage.codex ? usage.codex : {}, alertPercent, now),
    renderAntigravity(usage && usage.antigravity ? usage.antigravity : {}, alertPercent, now),
  ];
  renderOverall(states);
  const dashboard = document.getElementById('dashboard');
  if (dashboard) dashboard.setAttribute('aria-busy', 'false');
}

function renderOffline(error) {
  const data = { stale: true, error: error && error.message ? error.message : 'Dashboard service offline' };
  renderUsage({ claude: data, codex: data, antigravity: data });
  const element = document.getElementById('overall_state');
  if (element) element.textContent = 'offline';
}

async function refreshUsage() {
  try {
    const response = await fetch('/api/usage', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Usage API returned ${response.status}`);
    renderUsage(await response.json());
  } catch (error) {
    renderOffline(error);
  }
}

function installDesktopDrag() {
  const params = new URLSearchParams(window.location.search);
  const isDesktopShell = params.get('mode') === 'desktop' || /\bElectron\//.test(navigator.userAgent);
  if (!isDesktopShell) return;
  document.documentElement.classList.add('desktop-shell');
  document.body.classList.add('desktop-shell');
  if (!window.desktopHud) return;

  const watch = document.getElementById('dashboard');
  if (!watch) return;
  let pointerId = null;

  const stop = () => {
    if (pointerId === null) return;
    pointerId = null;
    window.desktopHud.endDrag();
  };

  watch.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
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
  installDesktopDrag();
  refreshUsage();
  setInterval(refreshUsage, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshUsage();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ageText, percentValue, quotaLevel, resetText, serviceState };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  init();
}
