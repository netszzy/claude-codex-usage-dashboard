'use strict';

// Kimi Code usage bridge for the local usage dashboard.
//
// Reads the Kimi Code CLI's own OAuth session (or a KIMI_USAGE_TOKEN override)
// and queries the official `GET {baseUrl}/usages` endpoint — the same endpoint
// the CLI's /usage command uses. The 5-hour rolling window and the 7-day quota
// are written to the dashboard's agent snapshot directory as kimi.json.
//
// The OAuth token is only ever sent to the official Kimi API. It is never
// written to the snapshot, logged, or read by the dashboard server.

const fs = require('fs');
const path = require('path');
const os = require('os');

function envNumber(name, fallback, options = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;
  return value;
}

const KIMI_CODE_HOME = process.env.KIMI_CODE_HOME
  || path.join(os.homedir(), '.kimi-code');
const CREDENTIALS_PATH = process.env.KIMI_CODE_CREDENTIALS
  || path.join(KIMI_CODE_HOME, 'credentials', 'kimi-code.json');
const BASE_URL = String(process.env.KIMI_USAGE_BASE_URL || 'https://api.kimi.com/coding/v1')
  .trim()
  .replace(/\/+$/, '');
const TOKEN_OVERRIDE = String(process.env.KIMI_USAGE_TOKEN || '').trim();
const AGENT_USAGE_DIR = process.env.AGENT_USAGE_DIR
  || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'agents');
const SNAPSHOT_PATH = process.env.KIMI_USAGE_SNAPSHOT
  || path.join(AGENT_USAGE_DIR, 'kimi.json');
const LABEL = String(process.env.KIMI_USAGE_LABEL || 'Kimi Code').trim() || 'Kimi Code';
const TIMEOUT_MS = envNumber('KIMI_USAGE_TIMEOUT_SECONDS', 8, { min: 3, max: 60 }) * 1000;
const STALE_AFTER_MS = envNumber('KIMI_USAGE_STALE_MINUTES', 30, { min: 1 }) * 60000;
const WATCH_SECONDS = envNumber('KIMI_USAGE_REFRESH_SECONDS', 300, { min: 30, max: 3600 });
const OAUTH_TOKEN_URL = String(process.env.KIMI_OAUTH_TOKEN_URL || 'https://auth.kimi.com/api/oauth/token').trim();
const OAUTH_CLIENT_ID = String(process.env.KIMI_OAUTH_CLIENT_ID || '17e5f671-d194-4dfb-9706-5516cb48c098').trim();
const TOKEN_REFRESH_SKEW_MS = 30000;
const TOKEN_LOCK_STALE_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOURCE = 'kimi-code-usages';

function timestampMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value > 1e12) return value;
  if (value > 1e9) return value * 1000;
  return null;
}

function readKimiAccessToken(options = {}) {
  if (options.token) return options.token;
  if (TOKEN_OVERRIDE) return TOKEN_OVERRIDE;
  const credentialsPath = options.credentialsPath || CREDENTIALS_PATH;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch {
    throw new Error(`Kimi OAuth credential not found at ${credentialsPath} — run the kimi CLI and /login first`);
  }
  const token = data && typeof data.access_token === 'string' ? data.access_token.trim() : '';
  if (!token) {
    throw new Error(`Kimi OAuth credential at ${credentialsPath} has no access_token — run the kimi CLI and /login first`);
  }
  const expiresAt = timestampMs(data.expires_at);
  if (expiresAt && Date.now() > expiresAt - 30000) {
    throw new Error('Kimi access token expired — open Kimi Code or run the kimi CLI to refresh it');
  }
  return token;
}

function readCredentialsFile(credentialsPath) {
  try {
    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function credentialAccessToken(data, now = Date.now()) {
  if (!data || typeof data.access_token !== 'string' || !data.access_token.trim()) return null;
  const expiresAt = timestampMs(data.expires_at);
  if (expiresAt && now > expiresAt - TOKEN_REFRESH_SKEW_MS) return null;
  return data.access_token.trim();
}

function acquireTokenLock(lockPath, now = Date.now()) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`);
      } finally {
        fs.closeSync(descriptor);
      }
      return true;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        try {
          if (now - fs.statSync(lockPath).mtimeMs > TOKEN_LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
      }
      return false;
    }
  }
  return false;
}

function releaseTokenLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

async function refreshKimiOAuthToken(options = {}) {
  const credentialsPath = options.credentialsPath || CREDENTIALS_PATH;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const current = readCredentialsFile(credentialsPath);
  const refreshToken = current && typeof current.refresh_token === 'string'
    ? current.refresh_token.trim()
    : '';
  if (!refreshToken) {
    throw new Error('Kimi OAuth credential has no refresh_token — run the kimi CLI and /login again');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
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
      throw new Error('Kimi refresh token was rejected — run the kimi CLI and /login again');
    }
    throw new Error(`Kimi token refresh failed: HTTP ${status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Kimi token refresh response was missing access_token');
  }
  const expiresIn = Number(payload.expires_in);
  const validExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900;
  const next = {
    ...current,
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string' && payload.refresh_token
      ? payload.refresh_token
      : refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + validExpiresIn,
    scope: typeof payload.scope === 'string' ? payload.scope : (current && current.scope) || '',
    token_type: typeof payload.token_type === 'string' && payload.token_type ? payload.token_type : 'Bearer',
    expires_in: validExpiresIn,
  };
  writeSnapshotAtomic(credentialsPath, next);
  return next.access_token;
}

async function ensureKimiAccessToken(options = {}) {
  if (options.token) return options.token;
  if (TOKEN_OVERRIDE) return TOKEN_OVERRIDE;
  const credentialsPath = options.credentialsPath || CREDENTIALS_PATH;
  const current = readCredentialsFile(credentialsPath);
  if (!current) {
    throw new Error(`Kimi OAuth credential not found at ${credentialsPath} — run the kimi CLI and /login first`);
  }
  const cached = credentialAccessToken(current);
  if (cached && !options.forceRefresh) return cached;

  const lockPath = `${credentialsPath}.kimi-usage.lock`;
  const locked = acquireTokenLock(lockPath);
  try {
    const reread = readCredentialsFile(credentialsPath);
    const usable = credentialAccessToken(reread);
    if (usable && !options.forceRefresh) return usable;
    return await refreshKimiOAuthToken({ ...options, credentialsPath });
  } catch (error) {
    const healed = credentialAccessToken(readCredentialsFile(credentialsPath));
    if (healed) return healed;
    throw error;
  } finally {
    if (locked) releaseTokenLock(lockPath);
  }
}

async function requestKimiUsages(baseUrl, accessToken, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/usages`, {
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
      ? 'Kimi authorization failed (401) — token expired or logged out; run the kimi CLI and /login to refresh'
      : status === 404
        ? `Kimi usage endpoint not available (404) at ${baseUrl}`
        : `Kimi usage request failed: HTTP ${status}`;
    const error = new Error(message);
    error.status = status;
    throw error;
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Kimi usage response exceeded 1 MiB');
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Kimi usage response was not a JSON object');
  }
  return payload;
}

async function fetchKimiUsage(options = {}) {
  const baseUrl = options.baseUrl || BASE_URL;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;
  const accessToken = options.accessToken || await ensureKimiAccessToken(options);
  try {
    return await requestKimiUsages(baseUrl, accessToken, timeoutMs, fetchImpl);
  } catch (error) {
    const canRetry = error && error.status === 401 && !options.accessToken && !options.token && !TOKEN_OVERRIDE;
    if (!canRetry) throw error;
    const refreshed = await ensureKimiAccessToken({ ...options, forceRefresh: true });
    return requestKimiUsages(baseUrl, refreshed, timeoutMs, fetchImpl);
  }
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function quotaWindowFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const limit = numberValue(detail.limit);
  const used = numberValue(detail.used);
  if (limit === null || limit <= 0 || used === null || used < 0) return null;
  const resetAt = Date.parse(typeof detail.resetTime === 'string' ? detail.resetTime : '');
  return {
    used: Math.round(Math.min(100, Math.max(0, (used / limit) * 100)) * 10) / 10,
    resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : null,
  };
}

function fiveHourEntry(limits) {
  if (!Array.isArray(limits)) return null;
  const timed = limits.filter((entry) => entry && entry.detail && entry.window);
  return timed.find((entry) => (
    Number(entry.window.duration) === 300
    && /MINUTE/i.test(String(entry.window.timeUnit || ''))
  )) || timed.find((entry) => quotaWindowFromDetail(entry.detail)) || null;
}

function parseKimiUsagePayload(payload) {
  if (!payload || typeof payload !== 'object') return { five: null, seven: null };
  const fiveEntry = fiveHourEntry(payload.limits);
  return {
    five: fiveEntry ? quotaWindowFromDetail(fiveEntry.detail) : null,
    seven: quotaWindowFromDetail(payload.usage),
  };
}

function buildKimiSnapshot(payload, now = Date.now(), options = {}) {
  const windows = parseKimiUsagePayload(payload);
  const list = [
    windows.five ? { id: 'five', label: '5H', ...windows.five } : null,
    windows.seven ? { id: 'seven', label: '7D', ...windows.seven } : null,
  ].filter(Boolean);
  if (!list.length) {
    throw new Error('Kimi usage response contained no usable quota windows');
  }
  return {
    label: options.label || LABEL,
    source: SOURCE,
    fetchedAt: now,
    staleAfterMs: options.staleAfterMs || STALE_AFTER_MS,
    windows: list,
  };
}

function writeSnapshotAtomic(filePath, data) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function hasUsableSnapshotWindows(snapshot) {
  return Boolean(snapshot && Array.isArray(snapshot.windows) && snapshot.windows.some((windowData) => (
    windowData && typeof windowData.used === 'number' && Number.isFinite(windowData.used)
  )));
}

function readExistingSnapshot(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function runOnce(options = {}) {
  const snapshotPath = options.snapshotPath || SNAPSHOT_PATH;
  const label = options.label || LABEL;
  const staleAfterMs = options.staleAfterMs || STALE_AFTER_MS;
  const now = options.now || (() => Date.now());
  const logger = options.logger || ((line) => console.log(`[kimi-usage-snapshot] ${line}`));
  try {
    const payload = await fetchKimiUsage(options);
    const snapshot = buildKimiSnapshot(payload, now(), { label, staleAfterMs });
    writeSnapshotAtomic(snapshotPath, snapshot);
    const summary = snapshot.windows
      .map((windowData) => `${windowData.label} ${windowData.used}%`)
      .join(' · ');
    logger(`updated ${snapshotPath}: ${summary}`);
    return { ok: true, snapshot };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const existing = readExistingSnapshot(snapshotPath);
    if (hasUsableSnapshotWindows(existing)) {
      logger(`refresh failed (${message}); keeping last good snapshot`);
      return { ok: false, keptLastGood: true, error: message };
    }
    const stub = {
      label,
      source: SOURCE,
      fetchedAt: now(),
      stale: true,
      staleAfterMs,
      error: message,
      windows: [],
    };
    try {
      writeSnapshotAtomic(snapshotPath, stub);
    } catch {}
    logger(`refresh failed (${message}); no previous snapshot available`);
    return { ok: false, keptLastGood: false, error: message };
  }
}

function parseCliArgs(argv) {
  const args = { watch: false, intervalSeconds: WATCH_SECONDS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--watch' || arg === '-w') {
      args.watch = true;
      const next = Number(argv[index + 1]);
      if (Number.isFinite(next) && next > 0) {
        args.intervalSeconds = Math.min(3600, Math.max(30, next));
        index += 1;
      }
    } else if (arg.startsWith('--interval=')) {
      args.watch = true;
      const next = Number(arg.slice('--interval='.length));
      if (Number.isFinite(next) && next > 0) {
        args.intervalSeconds = Math.min(3600, Math.max(30, next));
      }
    } else if (arg === '--once') {
      args.watch = false;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));
  runOnce().then((result) => {
    if (!args.watch) {
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    setInterval(() => {
      runOnce().catch(() => {});
    }, args.intervalSeconds * 1000);
  });
}

module.exports = {
  acquireTokenLock,
  buildKimiSnapshot,
  credentialAccessToken,
  ensureKimiAccessToken,
  fetchKimiUsage,
  hasUsableSnapshotWindows,
  parseCliArgs,
  parseKimiUsagePayload,
  quotaWindowFromDetail,
  readCredentialsFile,
  readKimiAccessToken,
  refreshKimiOAuthToken,
  runOnce,
  writeSnapshotAtomic,
};
