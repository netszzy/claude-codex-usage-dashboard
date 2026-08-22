'use strict';

const os = require('os');
const path = require('path');
const { readJsonObject } = require('../atomic-json');

function normalizeClaudeWindow(windowData) {
  if (!windowData || typeof windowData.used_percentage !== 'number') return null;
  return {
    used: windowData.used_percentage,
    resetAt: windowData.resets_at ? windowData.resets_at * 1000 : null,
  };
}

function createClaudeCollector(options = {}) {
  const cachePath = options.cachePath || process.env.CLAUDE_USAGE_CACHE
    || path.join(os.homedir(), '.claude', 'usage-cache.json');
  const staleMinutes = options.staleMinutes === undefined ? Number(process.env.CLAUDE_STALE_MINUTES || 10) : options.staleMinutes;
  const staleAfterMs = Math.max(0, Number.isFinite(staleMinutes) ? staleMinutes : 10) * 60000;
  const now = options.now || Date.now;

  function readClaudeUsage() {
    const data = readJsonObject(cachePath);
    if (!data || !data.rate_limits) {
      return {
        fetchedAt: null,
        five: null,
        seven: null,
        source: 'statusline-cache',
        stale: true,
        staleAfterMs,
      };
    }

    const fetchedAt = data.fetchedAt || null;
    return {
      fetchedAt,
      five: normalizeClaudeWindow(data.rate_limits.five_hour),
      seven: normalizeClaudeWindow(data.rate_limits.seven_day),
      source: 'statusline-cache',
      stale: !fetchedAt || now() - fetchedAt > staleAfterMs,
      staleAfterMs,
    };
  }

  return { readClaudeUsage };
}

const defaultCollector = createClaudeCollector();

module.exports = {
  createClaudeCollector,
  normalizeClaudeWindow,
  readClaudeUsage: defaultCollector.readClaudeUsage,
};
