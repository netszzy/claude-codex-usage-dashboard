'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonObject } = require('../atomic-json');

const AGENT_PRESETS = Object.freeze([
  { id: 'claude', label: 'Claude Code', accent: '#d99a5d', defaultVisible: true, source: 'statusline-cache' },
  { id: 'codex', label: 'Codex', accent: '#67bdb4', defaultVisible: true, source: 'codex-sessions' },
  { id: 'antigravity', label: 'Antigravity', accent: '#9fbd69', defaultVisible: true, source: 'antigravity-grpc' },
  { id: 'kimi', label: 'Kimi Code', accent: '#4e7df0', defaultVisible: false, source: 'local-bridge' },
  { id: 'grok', label: 'Grok', accent: '#c9a66b', defaultVisible: false, source: 'local-bridge' },
  { id: 'gemini', label: 'Gemini CLI', accent: '#79a9d8', defaultVisible: false, source: 'local-bridge' },
  { id: 'github-copilot', label: 'GitHub Copilot', accent: '#b49ad8', defaultVisible: false, source: 'local-bridge' },
  { id: 'cursor', label: 'Cursor', accent: '#c5b98b', defaultVisible: false, source: 'local-bridge' },
  { id: 'opencode', label: 'OpenCode', accent: '#82b692', defaultVisible: false, source: 'local-bridge' },
]);

function cleanAgentText(value, fallback, maxLength = 48) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function safeAgentId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)
    ? value
    : null;
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAgentWindow(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const used = typeof raw.used === 'number' && Number.isFinite(raw.used)
    ? Math.min(100, Math.max(0, raw.used))
    : null;
  const id = safeAgentId(raw.id) || `window-${index + 1}`;
  return {
    id,
    label: cleanAgentText(raw.label, id.toUpperCase(), 12),
    used,
    resetAt: timestampValue(raw.resetAt),
  };
}

function quotaWindows(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.windows)) {
    return raw.windows.slice(0, 4).map(normalizeAgentWindow).filter(Boolean);
  }
  return [
    normalizeAgentWindow({ ...(raw.five || {}), id: 'five', label: '5H' }, 0),
    normalizeAgentWindow({ ...(raw.seven || {}), id: 'seven', label: '7D' }, 1),
  ];
}

function normalizeAgentGroups(raw) {
  if (!raw || !Array.isArray(raw.groups)) return [];
  return raw.groups.slice(0, 4).map((group, index) => {
    if (!group || typeof group !== 'object') return null;
    return {
      id: safeAgentId(group.id) || `group-${index + 1}`,
      label: cleanAgentText(group.label, `Group ${index + 1}`, 36),
      windows: quotaWindows(group),
    };
  }).filter(Boolean);
}

function hasQuotaData(agent) {
  return agent.windows.some((windowData) => windowData.used !== null)
    || agent.groups.some((group) => group.windows.some((windowData) => windowData.used !== null));
}

function createSnapshotCollector(options = {}) {
  const directory = options.directory || process.env.AGENT_USAGE_DIR
    || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'agents');
  const staleMinutes = options.staleMinutes === undefined
    ? Number(process.env.EXTERNAL_AGENT_STALE_MINUTES || 120)
    : options.staleMinutes;
  const defaultStaleAfterMs = Math.max(0, Number.isFinite(staleMinutes) ? staleMinutes : 120) * 60000;
  const maxAgents = options.maxAgents || 32;
  const maxBytes = options.maxBytes || 256 * 1024;
  const presets = options.presets || AGENT_PRESETS;

  function normalizeAgentSnapshot(raw, metadata = {}, now = Date.now()) {
    const id = safeAgentId(metadata.id || (raw && raw.id));
    if (!id) return null;
    const staleAfterMs = raw && typeof raw.staleAfterMs === 'number'
      && Number.isFinite(raw.staleAfterMs) && raw.staleAfterMs >= 0
      ? Math.min(raw.staleAfterMs, 30 * 86400000)
      : defaultStaleAfterMs;
    const fetchedAt = timestampValue(raw && raw.fetchedAt);
    const accent = cleanAgentText(raw && raw.accent, metadata.accent || '#8ca0b3', 16);
    const agent = {
      id,
      label: cleanAgentText(raw && raw.label, metadata.label || id, 40),
      accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : metadata.accent || '#8ca0b3',
      source: cleanAgentText(raw && raw.source, metadata.source || 'local-bridge', 40),
      defaultVisible: metadata.defaultVisible === true,
      fetchedAt,
      stale: Boolean(raw && raw.stale) || !fetchedAt || now - fetchedAt > staleAfterMs,
      staleAfterMs,
      error: raw && raw.error ? cleanAgentText(raw.error, '', 160) : null,
      windows: quotaWindows(raw),
      groups: normalizeAgentGroups(raw),
    };
    agent.available = hasQuotaData(agent);
    return agent;
  }

  function builtinAgentSnapshot(metadata, data) {
    const groups = metadata.id === 'antigravity' && data && Array.isArray(data.groups)
      ? data.groups.map((group, index) => ({
        id: `group-${index + 1}`,
        label: group.label,
        five: group.five,
        seven: group.seven,
      }))
      : [];
    return normalizeAgentSnapshot({ ...data, groups }, metadata);
  }

  function readExternalAgentSnapshots(snapshotDirectory = directory) {
    let entries = [];
    try {
      entries = fs.readdirSync(snapshotDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, maxAgents);
    } catch {
      return [];
    }

    const byId = new Map(presets.map((preset) => [preset.id, preset]));
    return entries.map((entry) => {
      const id = safeAgentId(entry.name.slice(0, -5));
      if (!id || id === 'claude' || id === 'codex' || id === 'antigravity') return null;
      const filePath = path.join(snapshotDirectory, entry.name);
      try {
        if (fs.statSync(filePath).size > maxBytes) return null;
      } catch {
        return null;
      }
      const raw = readJsonObject(filePath);
      if (!raw) return null;
      return normalizeAgentSnapshot(raw, byId.get(id) || { id });
    }).filter(Boolean);
  }

  function buildAgentCatalog(agents) {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const catalog = presets.map((preset) => {
      const agent = byId.get(preset.id);
      return {
        id: preset.id,
        label: preset.label,
        accent: preset.accent,
        defaultVisible: preset.defaultVisible,
        available: Boolean(agent && agent.available),
        source: agent ? agent.source : preset.source,
        bridgeFile: preset.source === 'local-bridge' ? `${preset.id}.json` : null,
      };
    });
    const knownIds = new Set(catalog.map((agent) => agent.id));
    for (const agent of agents) {
      if (knownIds.has(agent.id)) continue;
      catalog.push({
        id: agent.id,
        label: agent.label,
        accent: agent.accent,
        defaultVisible: false,
        available: agent.available,
        source: agent.source,
        bridgeFile: `${agent.id}.json`,
      });
    }
    return catalog;
  }

  return {
    buildAgentCatalog,
    builtinAgentSnapshot,
    normalizeAgentSnapshot,
    readExternalAgentSnapshots,
  };
}

const defaultCollector = createSnapshotCollector();

module.exports = {
  AGENT_PRESETS,
  cleanAgentText,
  createSnapshotCollector,
  hasQuotaData,
  normalizeAgentGroups,
  normalizeAgentSnapshot: defaultCollector.normalizeAgentSnapshot,
  normalizeAgentWindow,
  quotaWindows,
  readExternalAgentSnapshots: defaultCollector.readExternalAgentSnapshots,
  safeAgentId,
  timestampValue,
  buildAgentCatalog: defaultCollector.buildAgentCatalog,
  builtinAgentSnapshot: defaultCollector.builtinAgentSnapshot,
};
