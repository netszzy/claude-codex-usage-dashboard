'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { envNumber } = require('../dashboard-config');

const DEFAULT_SCAN_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

function normalizeCodexWindow(windowData) {
  if (!windowData || typeof windowData.used_percent !== 'number') return null;
  return {
    used: windowData.used_percent,
    resetAt: windowData.resets_at ? windowData.resets_at * 1000 : null,
  };
}

function normalizeCodexRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return { five: null, seven: null };
  const windows = [rateLimits.primary, rateLimits.secondary].filter(Boolean);
  const fiveHour = windows.find((windowData) => windowData.window_minutes === 300)
    || (!rateLimits.primary || rateLimits.primary.window_minutes == null ? rateLimits.primary : null);
  const sevenDay = windows.find((windowData) => windowData.window_minutes === 10080)
    || (!rateLimits.secondary || rateLimits.secondary.window_minutes == null ? rateLimits.secondary : null);
  return {
    five: normalizeCodexWindow(fiveHour),
    seven: normalizeCodexWindow(sevenDay),
  };
}

function normalizeCodexAppServerRateLimits(result, now = Date.now(), options = {}) {
  if (!result || typeof result !== 'object') return null;
  const byLimitId = result.rateLimitsByLimitId;
  const rateLimits = byLimitId && byLimitId.codex ? byLimitId.codex : result.rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const adaptWindow = (windowData) => {
    if (!windowData || typeof windowData.usedPercent !== 'number') return null;
    return {
      used_percent: windowData.usedPercent,
      resets_at: windowData.resetsAt,
      window_minutes: windowData.windowDurationMins,
    };
  };
  const windows = normalizeCodexRateLimits({
    primary: adaptWindow(rateLimits.primary),
    secondary: adaptWindow(rateLimits.secondary),
  });
  if (!windows.five && !windows.seven) return null;
  const refreshMs = options.refreshMs || 60000;
  return {
    fetchedAt: now,
    five: windows.five,
    seven: windows.seven,
    source: 'codex-app-server',
    stale: false,
    staleAfterMs: Math.max(refreshMs * 3, 120000),
  };
}

function resolveCodexExecutable(env = process.env, platform = process.platform) {
  if (env.CODEX_EXECUTABLE) return env.CODEX_EXECUTABLE;
  if (platform !== 'win32' || !env.LOCALAPPDATA) return 'codex';
  const binDir = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let entries = [];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return 'codex';
  }
  const candidates = [];
  for (const entry of entries) {
    const candidate = entry.isDirectory()
      ? path.join(binDir, entry.name, 'codex.exe')
      : entry.name.toLowerCase() === 'codex.exe' ? path.join(binDir, entry.name) : null;
    if (!candidate) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) candidates.push({ candidate, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates.length ? candidates[0].candidate : 'codex';
}

function queryCodexAppServerRateLimits(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const executable = options.executable || resolveCodexExecutable();
  const timeoutMs = options.timeoutMs || 15000;
  const refreshMs = options.refreshMs || 60000;
  const now = options.now || Date.now;
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let timer = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve(data);
    };
    const failure = (message) => {
      const detail = stderrBuffer.trim().slice(-500);
      return new Error(detail ? `${message}: ${detail}` : message);
    };
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish(error);
      }
    };
    const handleLine = (line) => {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(failure(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: null });
        return;
      }
      if (message.id !== 2) return;
      if (message.error) {
        finish(failure(`Codex rate-limit request failed: ${JSON.stringify(message.error)}`));
        return;
      }
      const normalized = normalizeCodexAppServerRateLimits(message.result, now(), { refreshMs });
      if (!normalized) {
        finish(failure('Codex rate-limit response contained no usable windows'));
        return;
      }
      finish(null, normalized);
    };

    try {
      child = spawnImpl(executable, ['app-server', '--stdio'], {
        cwd: os.homedir(),
        env: {
          ...process.env,
          RUST_LOG: process.env.CODEX_RATE_LIMIT_RUST_LOG || 'error',
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    timer = setTimeout(() => finish(failure('Codex rate-limit request timed out')), timeoutMs);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) finish(failure(`Codex app-server exited before replying (${code})`));
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4000);
    });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 1024 * 1024) {
        finish(failure('Codex app-server response exceeded 1 MiB'));
        return;
      }
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) handleLine(line);
        if (settled) return;
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.on('spawn', () => send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'claude-codex-usage-dashboard', version: '0.2.0' },
        capabilities: { experimentalApi: false },
      },
    }));
  });
}

function parseCodexEventLine(lineBuffer, maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
  if (!lineBuffer || !lineBuffer.length || lineBuffer.length > maxLineBytes) return null;
  const line = lineBuffer.toString('utf8').trim();
  if (!line || !line.includes('token_count')) return null;
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = event && event.payload;
  if (!payload || payload.type !== 'token_count' || !payload.rate_limits) return null;
  const timestamp = Date.parse(event.timestamp || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return { timestamp, rateLimits: payload.rate_limits };
}

function createCodexCollector(options = {}) {
  const env = options.env || process.env;
  const lookbackDays = options.lookbackDays || envNumber('CODEX_LOOKBACK_DAYS', 14, {
    integer: true,
    min: 1,
    max: 365,
  }, env);
  const staleMinutes = options.staleMinutes === undefined
    ? envNumber('CODEX_STALE_MINUTES', 120, { min: 0 }, env)
    : options.staleMinutes;
  const refreshSeconds = options.refreshSeconds || envNumber('CODEX_RATE_LIMIT_REFRESH_SECONDS', 60, {
    integer: true,
    min: 15,
    max: 3600,
  }, env);
  const timeoutSeconds = options.timeoutSeconds || envNumber('CODEX_APP_SERVER_TIMEOUT_SECONDS', 15, {
    integer: true,
    min: 3,
    max: 60,
  }, env);
  const source = String(options.source || env.CODEX_RATE_LIMITS_SOURCE || 'auto').trim().toLowerCase();
  if (!new Set(['auto', 'sessions']).has(source)) {
    throw new Error('CODEX_RATE_LIMITS_SOURCE must be auto or sessions');
  }
  const sessionsDirectory = options.sessionsDirectory || env.CODEX_SESSIONS_DIR
    || path.join(os.homedir(), '.codex', 'sessions');
  const scanChunkBytes = options.scanChunkBytes || DEFAULT_SCAN_CHUNK_BYTES;
  const maxLineBytes = options.maxLineBytes || DEFAULT_MAX_LINE_BYTES;
  const sessionCacheMs = options.sessionCacheMs || 8000;
  const refreshMs = options.refreshMs || refreshSeconds * 1000;
  const timeoutMs = options.timeoutMs || timeoutSeconds * 1000;
  const staleAfterMs = Math.max(0, staleMinutes) * 60000;
  const now = options.now || Date.now;
  const warn = options.warn || ((message) => console.warn('[dashboard-server] Codex live rate-limit refresh failed:', message));
  let codexCache = {
    sessionCheckedAt: 0,
    directAttemptAt: 0,
    data: null,
    promise: null,
    lastWarning: null,
  };

  function getCodexDayDirectory(date) {
    return path.join(
      sessionsDirectory,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    );
  }

  function readLatestCodexSnapshot(filePath) {
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      let position = size;
      let suffix = Buffer.alloc(0);
      let discardSuffix = false;
      while (position > 0) {
        const start = Math.max(0, position - scanChunkBytes);
        const chunk = Buffer.allocUnsafe(position - start);
        const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, start);
        const combined = Buffer.concat([chunk.subarray(0, bytesRead), suffix]);
        let lineEnd = combined.length;
        let skipLine = discardSuffix;
        for (let index = combined.length - 1; index >= 0; index -= 1) {
          if (combined[index] !== 0x0a) continue;
          const line = combined.subarray(index + 1, lineEnd);
          if (skipLine) {
            skipLine = false;
          } else {
            const snapshot = parseCodexEventLine(line, maxLineBytes);
            if (snapshot) return snapshot;
          }
          lineEnd = index;
        }
        const prefix = combined.subarray(0, lineEnd);
        if (skipLine || prefix.length > maxLineBytes) {
          suffix = Buffer.alloc(0);
          discardSuffix = true;
        } else {
          suffix = Buffer.from(prefix);
          discardSuffix = false;
        }
        position = start;
      }
      return discardSuffix ? null : parseCodexEventLine(suffix, maxLineBytes);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  function listCodexSessionFiles(current = new Date()) {
    const candidates = [];
    for (let dayOffset = 0; dayOffset < lookbackDays; dayOffset += 1) {
      const day = new Date(current.getTime() - dayOffset * 86400000);
      const directory = getCodexDayDirectory(day);
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(directory, entry.name);
        try {
          candidates.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
        } catch {}
      }
    }
    return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  }

  function readCodexUsage() {
    if (!fs.existsSync(sessionsDirectory)) {
      return {
        fetchedAt: null,
        five: null,
        seven: null,
        source: 'codex-sessions',
        stale: true,
        staleAfterMs,
      };
    }
    let newest = null;
    for (const candidate of listCodexSessionFiles()) {
      if (newest && candidate.mtimeMs < newest.timestamp) break;
      try {
        const snapshot = readLatestCodexSnapshot(candidate.filePath);
        if (snapshot && (!newest || snapshot.timestamp > newest.timestamp)) newest = snapshot;
      } catch {}
    }
    if (!newest) {
      return {
        fetchedAt: null,
        five: null,
        seven: null,
        source: 'codex-sessions',
        stale: true,
        staleAfterMs,
      };
    }
    const windows = normalizeCodexRateLimits(newest.rateLimits);
    return {
      fetchedAt: newest.timestamp,
      five: windows.five,
      seven: windows.seven,
      source: 'codex-sessions',
      stale: now() - newest.timestamp > staleAfterMs,
      staleAfterMs,
    };
  }

  const readUsage = options.readUsage || readCodexUsage;
  const queryRateLimits = options.queryRateLimits || (() => queryCodexAppServerRateLimits({
    timeoutMs,
    refreshMs,
    now,
  }));

  function getCodexUsage() {
    const current = now();
    if (!codexCache.data || current - codexCache.sessionCheckedAt >= sessionCacheMs) {
      let sessionData = null;
      try {
        sessionData = readUsage();
      } catch (error) {
        sessionData = {
          fetchedAt: null,
          five: null,
          seven: null,
          source: 'codex-sessions',
          stale: true,
          staleAfterMs,
          error: error.message,
        };
      }
      const directDataIsFresh = codexCache.data
        && codexCache.data.source === 'codex-app-server'
        && current - codexCache.data.fetchedAt <= codexCache.data.staleAfterMs;
      if (!codexCache.data || (!directDataIsFresh && sessionData.fetchedAt
        && sessionData.fetchedAt > (codexCache.data.fetchedAt || 0))) {
        codexCache.data = sessionData;
      }
      codexCache.sessionCheckedAt = current;
    }
    if (codexCache.data && codexCache.data.source === 'codex-app-server'
      && current - codexCache.data.fetchedAt > codexCache.data.staleAfterMs) {
      codexCache.data = { ...codexCache.data, stale: true };
    }
    if (source !== 'sessions' && !codexCache.promise && current - codexCache.directAttemptAt >= refreshMs) {
      codexCache.directAttemptAt = current;
      codexCache.promise = queryRateLimits()
        .then((data) => {
          codexCache.data = data;
          codexCache.lastWarning = null;
        })
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          if (message !== codexCache.lastWarning) {
            warn(message);
            codexCache.lastWarning = message;
          }
        })
        .finally(() => {
          codexCache.promise = null;
        });
    }
    return codexCache.data;
  }

  return {
    getCodexDayDirectory,
    getCodexUsage,
    listCodexSessionFiles,
    readCodexUsage,
    readLatestCodexSnapshot,
  };
}

const defaultCollector = createCodexCollector();

module.exports = {
  createCodexCollector,
  getCodexUsage: defaultCollector.getCodexUsage,
  normalizeCodexAppServerRateLimits,
  normalizeCodexRateLimits,
  parseCodexEventLine,
  queryCodexAppServerRateLimits,
  readCodexUsage: defaultCollector.readCodexUsage,
  readLatestCodexSnapshot: defaultCollector.readLatestCodexSnapshot,
  resolveCodexExecutable,
};
