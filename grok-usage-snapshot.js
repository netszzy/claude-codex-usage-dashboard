'use strict';

// Grok Build usage bridge for the local usage dashboard.
//
// Reads the Grok CLI OAuth session from ~/.grok/auth.json (or a token
// override) and queries the same billing endpoint the CLI /usage command uses:
//   GET {baseUrl}/billing?format=credits
//
// Weekly (or period) credit usage is written to the dashboard agent snapshot
// directory as grok.json. The access token is only sent to the official
// cli-chat-proxy host. It is never written to the snapshot, logged, or read
// by the dashboard server.

const path = require('path');
const os = require('os');
const {
  acquireTokenLock,
  envNumber,
  hasUsableSnapshotWindows,
  parseCliArgs: parseSnapshotCliArgs,
  readJsonObject,
  releaseTokenLock,
  runSnapshotOnce,
  runWatchLoop,
  timestampMs,
  writeCredentialWithBackup,
  writeJsonAtomic: writeSnapshotAtomic,
} = require('./lib/snapshot-core');

const GROK_HOME = process.env.GROK_HOME
  || path.join(os.homedir(), '.grok');
const AUTH_PATH = process.env.GROK_AUTH_PATH
  || path.join(GROK_HOME, 'auth.json');
const BASE_URL = String(process.env.GROK_USAGE_BASE_URL || 'https://cli-chat-proxy.grok.com/v1')
  .trim()
  .replace(/\/+$/, '');
const TOKEN_OVERRIDE = String(process.env.GROK_USAGE_TOKEN || process.env.XAI_API_KEY || '').trim();
const AGENT_USAGE_DIR = process.env.AGENT_USAGE_DIR
  || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'agents');
const SNAPSHOT_PATH = process.env.GROK_USAGE_SNAPSHOT
  || path.join(AGENT_USAGE_DIR, 'grok.json');
const LABEL = String(process.env.GROK_USAGE_LABEL || 'Grok').trim() || 'Grok';
const TIMEOUT_MS = envNumber('GROK_USAGE_TIMEOUT_SECONDS', 8, { min: 3, max: 60 }) * 1000;
const STALE_AFTER_MS = envNumber('GROK_USAGE_STALE_MINUTES', 30, { min: 1 }) * 60000;
const WATCH_SECONDS = envNumber('GROK_USAGE_REFRESH_SECONDS', 300, { min: 30, max: 3600 });
const OAUTH_TOKEN_URL = String(process.env.GROK_OAUTH_TOKEN_URL || 'https://auth.x.ai/oauth2/token').trim();
const DEFAULT_OAUTH_CLIENT_ID = String(
  process.env.GROK_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828',
).trim();
const TOKEN_REFRESH_SKEW_MS = 60000;
const TOKEN_LOCK_STALE_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOURCE = 'grok-billing-credits';

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && 'val' in value) return numberValue(value.val);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value) {
  if (value === null) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function writeBackEnabled(env = process.env) {
  return String(env.GROK_USAGE_WRITE_BACK || '').trim().toLowerCase() !== 'off';
}

function pickAuthEntry(authFile) {
  if (!authFile || typeof authFile !== 'object' || Array.isArray(authFile)) return null;
  const entries = Object.entries(authFile)
    .map(([slot, value]) => ({ slot, value }))
    .filter((entry) => entry.value && typeof entry.value === 'object');
  if (!entries.length) return null;

  const ranked = entries.map((entry) => {
    const value = entry.value;
    const hasKey = typeof value.key === 'string' && value.key.trim();
    const hasRefresh = typeof value.refresh_token === 'string' && value.refresh_token.trim();
    const expiresAt = timestampMs(value.expires_at);
    let score = 0;
    if (hasKey) score += 4;
    if (hasRefresh) score += 2;
    if (String(value.auth_mode || '').toLowerCase() === 'oidc') score += 1;
    if (expiresAt && expiresAt > Date.now()) score += 1;
    if (String(entry.slot).includes('auth.x.ai')) score += 1;
    return { ...entry, score, expiresAt };
  });
  ranked.sort((left, right) => right.score - left.score || (right.expiresAt || 0) - (left.expiresAt || 0));
  return ranked[0];
}

function readAuthFile(authPath = AUTH_PATH) {
  return readJsonObject(authPath);
}

function accessTokenFromEntry(entry, now = Date.now()) {
  if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) return null;
  const expiresAt = timestampMs(entry.expires_at);
  if (expiresAt && now > expiresAt - TOKEN_REFRESH_SKEW_MS) return null;
  return entry.key.trim();
}

function clientIdFromEntry(entry, slot = '') {
  if (entry && typeof entry.oidc_client_id === 'string' && entry.oidc_client_id.trim()) {
    return entry.oidc_client_id.trim();
  }
  if (typeof slot === 'string' && slot.includes('::')) {
    const maybe = slot.split('::').pop();
    if (maybe && maybe.trim()) return maybe.trim();
  }
  return DEFAULT_OAUTH_CLIENT_ID;
}

function validateGrokAuthFile(authFile, slot, expectedRefreshToken = '') {
  if (!authFile || typeof authFile !== 'object' || Array.isArray(authFile)) return 'credential JSON is not an object';
  const entry = authFile[slot];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'selected OAuth entry is missing';
  if (typeof entry.key !== 'string' || !entry.key.trim()) return 'selected OAuth entry has no key';
  if (typeof entry.refresh_token !== 'string' || !entry.refresh_token.trim()) {
    return 'selected OAuth entry has no refresh_token';
  }
  if (!timestampMs(entry.expires_at)) return 'selected OAuth entry has invalid expires_at';
  if (expectedRefreshToken && entry.refresh_token.trim() !== expectedRefreshToken) {
    return 'credential changed while the token refresh was in flight';
  }
  return null;
}

async function refreshGrokOAuthToken(options = {}) {
  const authPath = options.authPath || AUTH_PATH;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const authFile = readAuthFile(authPath);
  const picked = pickAuthEntry(authFile);
  if (!picked) {
    throw new Error(`Grok OAuth credential not found at ${authPath} — run grok login first`);
  }
  const refreshToken = typeof picked.value.refresh_token === 'string'
    ? picked.value.refresh_token.trim()
    : '';
  if (!refreshToken) {
    throw new Error('Grok OAuth credential has no refresh_token — run grok login again');
  }
  const clientId = clientIdFromEntry(picked.value, picked.slot);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(options.oauthTokenUrl || OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const status = response.status;
    if (status === 400 || status === 401) {
      throw new Error('Grok refresh token was rejected — run grok login again');
    }
    throw new Error(`Grok token refresh failed: HTTP ${status}`);
  }
  const payload = await response.json();
  const accessToken = payload && typeof payload.access_token === 'string'
    ? payload.access_token.trim()
    : '';
  if (!accessToken) {
    throw new Error('Grok token refresh response was missing access_token');
  }
  const expiresIn = Number(payload.expires_in);
  const validExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 21600;
  writeCredentialWithBackup(
    authPath,
    (target) => ({
      ...target,
      [picked.slot]: {
        ...target[picked.slot],
        key: accessToken,
        refresh_token: typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
          ? payload.refresh_token.trim()
          : refreshToken,
        expires_at: new Date(Date.now() + validExpiresIn * 1000).toISOString(),
        oidc_client_id: clientId,
      },
    }),
    (target) => validateGrokAuthFile(target, picked.slot, refreshToken),
    {
      writeBack: options.writeBack === undefined ? writeBackEnabled() : options.writeBack,
      warn: options.warn || ((message) => console.warn(`[grok-usage-snapshot] ${message}`)),
    },
  );
  return accessToken;
}

async function ensureGrokAccessToken(options = {}) {
  if (options.token) return options.token;
  if (TOKEN_OVERRIDE) return TOKEN_OVERRIDE;
  const authPath = options.authPath || AUTH_PATH;
  const authFile = readAuthFile(authPath);
  const picked = pickAuthEntry(authFile);
  if (!picked) {
    throw new Error(`Grok OAuth credential not found at ${authPath} — run grok login first`);
  }
  const cached = accessTokenFromEntry(picked.value);
  if (cached && !options.forceRefresh) return cached;

  const lockPath = `${authPath}.grok-usage.lock`;
  const locked = acquireTokenLock(lockPath, Date.now(), { staleMs: TOKEN_LOCK_STALE_MS });
  try {
    const reread = pickAuthEntry(readAuthFile(authPath));
    const usable = reread ? accessTokenFromEntry(reread.value) : null;
    if (usable && !options.forceRefresh) return usable;
    return await refreshGrokOAuthToken({ ...options, authPath });
  } catch (error) {
    const healed = pickAuthEntry(readAuthFile(authPath));
    const usable = healed ? accessTokenFromEntry(healed.value) : null;
    if (usable) return usable;
    throw error;
  } finally {
    if (locked) releaseTokenLock(lockPath);
  }
}

async function requestGrokBilling(baseUrl, accessToken, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/billing?format=credits`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const status = response.status;
    const message = status === 401
      ? 'Grok authorization failed (401) — token expired or logged out; run grok login to refresh'
      : status === 403
        ? 'Grok billing requires a grok.com OAuth session — run grok login (API keys may not expose credits)'
        : status === 404
          ? `Grok billing endpoint not available (404) at ${baseUrl}`
          : `Grok billing request failed: HTTP ${status}`;
    const error = new Error(message);
    error.status = status;
    throw error;
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Grok billing response exceeded 1 MiB');
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Grok billing response was not a JSON object');
  }
  return payload;
}

async function fetchGrokUsage(options = {}) {
  const baseUrl = options.baseUrl || BASE_URL;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = options.accessToken || await ensureGrokAccessToken(options);
  try {
    return await requestGrokBilling(baseUrl, accessToken, timeoutMs, fetchImpl);
  } catch (error) {
    const canRetry = error && error.status === 401
      && !options.accessToken
      && !options.token
      && !TOKEN_OVERRIDE;
    if (!canRetry) throw error;
    const refreshed = await ensureGrokAccessToken({ ...options, forceRefresh: true });
    return requestGrokBilling(baseUrl, refreshed, timeoutMs, fetchImpl);
  }
}

function billingConfig(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.config && typeof payload.config === 'object') return payload.config;
  return payload;
}

function periodWindowMeta(periodType) {
  const text = String(periodType || '').toUpperCase();
  if (text.includes('DAY') && !text.includes('WEEK') && !text.includes('MONTH')) {
    return { id: 'day', label: '1D' };
  }
  if (text.includes('MONTH')) {
    return { id: 'thirty', label: '30D' };
  }
  // SuperGrok / unified billing defaults to a weekly period.
  return { id: 'seven', label: '7D' };
}

function productLabel(product) {
  const raw = String(product || '').trim();
  if (!raw) return 'Product';
  if (/^grokbuild$/i.test(raw)) return 'Grok Build';
  if (/^grokchat$/i.test(raw)) return 'Grok Chat';
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').slice(0, 36);
}

function productId(product, index) {
  const raw = String(product || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (raw && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(raw)) return raw;
  return `product-${index + 1}`;
}

function parseGrokBillingPayload(payload) {
  const config = billingConfig(payload);
  if (!config) return { windows: [], groups: [] };

  const period = config.currentPeriod && typeof config.currentPeriod === 'object'
    ? config.currentPeriod
    : null;
  const periodMeta = periodWindowMeta(period && period.type);
  const resetAt = timestampMs(config.billingPeriodEnd)
    || timestampMs(period && period.end)
    || null;

  const creditUsage = clampPercent(numberValue(config.creditUsagePercent));
  const windows = [];
  if (creditUsage !== null) {
    windows.push({
      id: periodMeta.id,
      label: periodMeta.label,
      used: creditUsage,
      resetAt,
    });
  } else {
    // Non-unified billing shapes may expose absolute used/limit instead.
    const used = numberValue(config.used);
    const monthlyLimit = numberValue(config.monthlyLimit);
    if (used !== null && monthlyLimit !== null && monthlyLimit > 0) {
      windows.push({
        id: periodMeta.id,
        label: periodMeta.label,
        used: clampPercent((used / monthlyLimit) * 100),
        resetAt,
      });
    }
  }

  const groups = [];
  if (Array.isArray(config.productUsage)) {
    config.productUsage.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const used = clampPercent(numberValue(entry.usagePercent));
      if (used === null) return;
      groups.push({
        id: productId(entry.product, index),
        label: productLabel(entry.product),
        windows: [{
          id: periodMeta.id,
          label: periodMeta.label,
          used,
          resetAt,
        }],
      });
    });
  }

  return { windows, groups };
}

function buildGrokSnapshot(payload, now = Date.now(), options = {}) {
  const parsed = parseGrokBillingPayload(payload);
  if (!parsed.windows.length && !parsed.groups.length) {
    throw new Error('Grok billing response contained no usable credit usage');
  }
  // Prefer a single top-level period window when present. Product groups are
  // only attached when the overall window is missing, so the card stays on the
  // account credit pool (what /usage shows) rather than product slices.
  const useGroupsOnly = !parsed.windows.length && parsed.groups.length > 0;
  return {
    label: options.label || LABEL,
    source: SOURCE,
    fetchedAt: now,
    staleAfterMs: options.staleAfterMs || STALE_AFTER_MS,
    windows: useGroupsOnly ? [] : parsed.windows,
    groups: useGroupsOnly ? parsed.groups : [],
  };
}

async function runOnce(options = {}) {
  const snapshotPath = options.snapshotPath || SNAPSHOT_PATH;
  const label = options.label || LABEL;
  const staleAfterMs = options.staleAfterMs || STALE_AFTER_MS;
  const now = options.now || (() => Date.now());
  const logger = options.logger || ((line) => console.log(`[grok-usage-snapshot] ${line}`));
  return runSnapshotOnce({
    buildSnapshot: (payload, timestamp) => buildGrokSnapshot(payload, timestamp, { label, staleAfterMs }),
    fetchUsage: () => fetchGrokUsage(options),
    includeGroups: true,
    label,
    logger,
    now,
    snapshotPath,
    source: SOURCE,
    staleAfterMs,
    summarize: (snapshot) => (snapshot.windows.length
      ? snapshot.windows
      : snapshot.groups.flatMap((group) => group.windows.map((windowData) => ({
        ...windowData,
        label: `${group.label} ${windowData.label}`,
      }))))
      .map((windowData) => `${windowData.label} ${windowData.used}%`)
      .join(' · '),
  });
}

function parseCliArgs(argv) {
  return parseSnapshotCliArgs(argv, WATCH_SECONDS, {
    defaultWriteBack: writeBackEnabled(),
  });
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  runWatchLoop(() => runOnce({ writeBack: args.writeBack !== false }), args);
}

module.exports = {
  accessTokenFromEntry,
  acquireTokenLock,
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
  validateGrokAuthFile,
  writeBackEnabled,
  writeSnapshotAtomic,
};
