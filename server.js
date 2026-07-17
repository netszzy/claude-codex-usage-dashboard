'use strict';

const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOST = process.env.HOST || '127.0.0.1';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

if (!LOCAL_HOSTS.has(HOST)) {
  throw new Error('HOST must be a loopback address: 127.0.0.1, localhost, or ::1');
}

function envNumber(name, fallback, options = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be at most ${options.max}`);
  }
  return value;
}

const PORT = envNumber('PORT', 8787, { integer: true, min: 1, max: 65535 });
const ALERT_PERCENT = envNumber('ALERT_PERCENT', 85, { min: 0, max: 100 });
const CODEX_LOOKBACK_DAYS = envNumber('CODEX_LOOKBACK_DAYS', 14, { integer: true, min: 1, max: 365 });
const CLAUDE_STALE_MINUTES = envNumber('CLAUDE_STALE_MINUTES', 10, { min: 0 });
const CODEX_STALE_MINUTES = envNumber('CODEX_STALE_MINUTES', 120, { min: 0 });
const CODEX_RATE_LIMIT_REFRESH_SECONDS = envNumber('CODEX_RATE_LIMIT_REFRESH_SECONDS', 60, {
  integer: true,
  min: 15,
  max: 3600,
});
const CODEX_APP_SERVER_TIMEOUT_SECONDS = envNumber('CODEX_APP_SERVER_TIMEOUT_SECONDS', 15, {
  integer: true,
  min: 3,
  max: 60,
});
const ANTIGRAVITY_STALE_MINUTES = envNumber('ANTIGRAVITY_STALE_MINUTES', 120, { min: 0 });
const EXTERNAL_AGENT_STALE_MINUTES = envNumber('EXTERNAL_AGENT_STALE_MINUTES', 120, { min: 0 });
const KIMI_USAGE_REFRESH_SECONDS = envNumber('KIMI_USAGE_REFRESH_SECONDS', 60, {
  integer: true,
  min: 15,
  max: 3600,
});
const KIMI_USAGE_REFRESH_MS = KIMI_USAGE_REFRESH_SECONDS * 1000;
const KIMI_USAGE_BRIDGE = String(process.env.KIMI_USAGE_BRIDGE || 'auto').trim().toLowerCase();
const KIMI_BRIDGE_SCRIPT = path.join(__dirname, 'kimi-usage-snapshot.js');
const KIMI_BRIDGE_TIMEOUT_MS = 30000;

if (!new Set(['auto', 'off']).has(KIMI_USAGE_BRIDGE)) {
  throw new Error('KIMI_USAGE_BRIDGE must be auto or off');
}
const CODEX_SCAN_CHUNK_BYTES = 256 * 1024;
const CODEX_MAX_LINE_BYTES = 2 * 1024 * 1024;
const CODEX_SESSION_CACHE_MS = 8000;
const CODEX_RATE_LIMIT_REFRESH_MS = CODEX_RATE_LIMIT_REFRESH_SECONDS * 1000;
const CODEX_APP_SERVER_TIMEOUT_MS = CODEX_APP_SERVER_TIMEOUT_SECONDS * 1000;
const CODEX_RATE_LIMITS_SOURCE = String(process.env.CODEX_RATE_LIMITS_SOURCE || 'auto').trim().toLowerCase();
const MAX_EXTERNAL_AGENTS = 32;
const MAX_EXTERNAL_AGENT_BYTES = 256 * 1024;

if (!new Set(['auto', 'sessions']).has(CODEX_RATE_LIMITS_SOURCE)) {
  throw new Error('CODEX_RATE_LIMITS_SOURCE must be auto or sessions');
}

const CLAUDE_CACHE = process.env.CLAUDE_USAGE_CACHE
  || path.join(os.homedir(), '.claude', 'usage-cache.json');
const CODEX_SESSIONS = process.env.CODEX_SESSIONS_DIR
  || path.join(os.homedir(), '.codex', 'sessions');
const ANTIGRAVITY_LOG_DIR = process.env.ANTIGRAVITY_LOG_DIR
  || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
const ANTIGRAVITY_SETTINGS = process.env.ANTIGRAVITY_SETTINGS
  || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const ANTIGRAVITY_CACHE = process.env.ANTIGRAVITY_USAGE_CACHE
  || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'antigravity-usage-cache.json');
const LEGACY_ANTIGRAVITY_CACHE = process.env.ANTIGRAVITY_USAGE_CACHE
  ? null
  : path.join(path.dirname(CLAUDE_CACHE), 'antigravity-usage-cache.json');
const EXTERNAL_AGENT_USAGE_DIR = process.env.AGENT_USAGE_DIR
  || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'agents');
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const DASHBOARD_CSS = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const DASHBOARD_JS = fs.readFileSync(path.join(__dirname, 'dashboard.js'), 'utf8');

const AGENT_PRESETS = Object.freeze([
  { id: 'claude', label: 'Claude Code', accent: '#d99a5d', defaultVisible: true, source: 'statusline-cache' },
  { id: 'codex', label: 'Codex', accent: '#67bdb4', defaultVisible: true, source: 'codex-sessions' },
  { id: 'antigravity', label: 'Antigravity', accent: '#9fbd69', defaultVisible: true, source: 'antigravity-grpc' },
  { id: 'kimi', label: 'Kimi Code', accent: '#4e7df0', defaultVisible: false, source: 'local-bridge' },
  { id: 'gemini', label: 'Gemini CLI', accent: '#79a9d8', defaultVisible: false, source: 'local-bridge' },
  { id: 'github-copilot', label: 'GitHub Copilot', accent: '#b49ad8', defaultVisible: false, source: 'local-bridge' },
  { id: 'cursor', label: 'Cursor', accent: '#c5b98b', defaultVisible: false, source: 'local-bridge' },
  { id: 'opencode', label: 'OpenCode', accent: '#82b692', defaultVisible: false, source: 'local-bridge' },
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
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

function normalizeClaudeWindow(windowData) {
  if (!windowData || typeof windowData.used_percentage !== 'number') return null;
  return {
    used: windowData.used_percentage,
    resetAt: windowData.resets_at ? windowData.resets_at * 1000 : null,
  };
}

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

function normalizeCodexAppServerRateLimits(result, now = Date.now()) {
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

  return {
    fetchedAt: now,
    five: windows.five,
    seven: windows.seven,
    source: 'codex-app-server',
    stale: false,
    staleAfterMs: Math.max(CODEX_RATE_LIMIT_REFRESH_MS * 3, 120000),
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
  const timeoutMs = options.timeoutMs || CODEX_APP_SERVER_TIMEOUT_MS;
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
      const normalized = normalizeCodexAppServerRateLimits(message.result, now());
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
        clientInfo: { name: 'claude-codex-usage-dashboard', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      },
    }));
  });
}

function readClaudeUsage() {
  const data = readJson(CLAUDE_CACHE);
  if (!data || !data.rate_limits) {
    return {
      fetchedAt: null,
      five: null,
      seven: null,
      source: 'statusline-cache',
      stale: true,
      staleAfterMs: CLAUDE_STALE_MINUTES * 60000,
    };
  }

  const fetchedAt = data.fetchedAt || null;
  const staleAfterMs = CLAUDE_STALE_MINUTES * 60000;
  const stale = !fetchedAt || Date.now() - fetchedAt > staleAfterMs;

  return {
    fetchedAt,
    five: normalizeClaudeWindow(data.rate_limits.five_hour),
    seven: normalizeClaudeWindow(data.rate_limits.seven_day),
    source: 'statusline-cache',
    stale,
    staleAfterMs,
  };
}

function getCodexDayDirectory(date) {
  return path.join(
    CODEX_SESSIONS,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function parseCodexEventLine(lineBuffer) {
  if (!lineBuffer || !lineBuffer.length || lineBuffer.length > CODEX_MAX_LINE_BYTES) return null;
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

function readLatestCodexSnapshot(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    let position = size;
    let suffix = Buffer.alloc(0);
    let discardSuffix = false;

    while (position > 0) {
      const start = Math.max(0, position - CODEX_SCAN_CHUNK_BYTES);
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
          const snapshot = parseCodexEventLine(line);
          if (snapshot) return snapshot;
        }
        lineEnd = index;
      }

      const prefix = combined.subarray(0, lineEnd);
      if (skipLine || prefix.length > CODEX_MAX_LINE_BYTES) {
        suffix = Buffer.alloc(0);
        discardSuffix = true;
      } else {
        suffix = Buffer.from(prefix);
        discardSuffix = false;
      }
      position = start;
    }

    return discardSuffix ? null : parseCodexEventLine(suffix);
  } finally {
    fs.closeSync(descriptor);
  }
}

function listCodexSessionFiles(now = new Date()) {
  const candidates = [];
  for (let dayOffset = 0; dayOffset < CODEX_LOOKBACK_DAYS; dayOffset += 1) {
    const day = new Date(now.getTime() - dayOffset * 86400000);
    const dir = getCodexDayDirectory(day);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      try {
        candidates.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
      } catch {}
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readCodexUsage() {
  if (!fs.existsSync(CODEX_SESSIONS)) {
    return {
      fetchedAt: null,
      five: null,
      seven: null,
      source: 'codex-sessions',
      stale: true,
      staleAfterMs: CODEX_STALE_MINUTES * 60000,
    };
  }

  let newest = null;
  for (const candidate of listCodexSessionFiles()) {
    if (newest && candidate.mtimeMs < newest.timestamp) break;
    try {
      const snapshot = readLatestCodexSnapshot(candidate.filePath);
      if (snapshot && (!newest || snapshot.timestamp > newest.timestamp)) {
        newest = snapshot;
      }
    } catch {}
  }

  if (!newest) {
    return {
      fetchedAt: null,
      five: null,
      seven: null,
      source: 'codex-sessions',
      stale: true,
      staleAfterMs: CODEX_STALE_MINUTES * 60000,
    };
  }

  const staleAfterMs = CODEX_STALE_MINUTES * 60000;
  const stale = Date.now() - newest.timestamp > staleAfterMs;
  const windows = normalizeCodexRateLimits(newest.rateLimits);

  return {
    fetchedAt: newest.timestamp,
    five: windows.five,
    seven: windows.seven,
    source: 'codex-sessions',
    stale,
    staleAfterMs,
  };
}

let codexCache = {
  sessionCheckedAt: 0,
  directAttemptAt: 0,
  data: null,
  promise: null,
  lastWarning: null,
};

function getCodexUsage() {
  const now = Date.now();
  if (!codexCache.data || now - codexCache.sessionCheckedAt >= CODEX_SESSION_CACHE_MS) {
    let sessionData = null;
    try {
      sessionData = readCodexUsage();
    } catch (error) {
      sessionData = {
        fetchedAt: null,
        five: null,
        seven: null,
        source: 'codex-sessions',
        stale: true,
        staleAfterMs: CODEX_STALE_MINUTES * 60000,
        error: error.message,
      };
    }
    const directDataIsFresh = codexCache.data
      && codexCache.data.source === 'codex-app-server'
      && now - codexCache.data.fetchedAt <= codexCache.data.staleAfterMs;
    if (!codexCache.data
      || (!directDataIsFresh
        && sessionData.fetchedAt
        && sessionData.fetchedAt > (codexCache.data.fetchedAt || 0))) {
      codexCache.data = sessionData;
    }
    codexCache.sessionCheckedAt = now;
  }

  if (codexCache.data
    && codexCache.data.source === 'codex-app-server'
    && now - codexCache.data.fetchedAt > codexCache.data.staleAfterMs) {
    codexCache.data = { ...codexCache.data, stale: true };
  }

  if (CODEX_RATE_LIMITS_SOURCE !== 'sessions'
    && !codexCache.promise
    && now - codexCache.directAttemptAt >= CODEX_RATE_LIMIT_REFRESH_MS) {
    codexCache.directAttemptAt = now;
    codexCache.promise = queryCodexAppServerRateLimits()
      .then((data) => {
        codexCache.data = data;
        codexCache.lastWarning = null;
      })
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        if (message !== codexCache.lastWarning) {
          console.warn('[dashboard-server] Codex live rate-limit refresh failed:', message);
          codexCache.lastWarning = message;
        }
      })
      .finally(() => {
        codexCache.promise = null;
      });
  }

  return codexCache.data;
}

function antigravityLineTimestamp(line, fileTimeMs) {
  const match = /^.[ ]?(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!match) return null;
  const year = new Date(fileTimeMs || Date.now()).getFullYear();
  const value = new Date(
    year,
    Number(match[1]) - 1,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return Number.isFinite(value) ? value : null;
}

function antigravityTokenExpiry(line) {
  const match = /token refreshed, new expiry=(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!match) return null;
  const value = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  return Number.isFinite(value) ? value : null;
}

function readProtoVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  let bytes = 0;
  while (pos < buffer.length && bytes < 10) {
    const byte = buffer[pos];
    pos += 1;
    bytes += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Protobuf varint exceeds the safe integer range');
      }
      return [Number(value), pos];
    }
    shift += 7n;
  }
  throw new Error('Invalid protobuf varint');
}

function parseProtoFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, tagEnd] = readProtoVarint(buffer, offset);
    offset = tagEnd;
    const field = tag >> 3;
    const wire = tag & 7;
    if (!field) break;

    if (wire === 0) {
      const [value, next] = readProtoVarint(buffer, offset);
      fields.push({ field, wire, value });
      offset = next;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error('Truncated protobuf fixed64 field');
      fields.push({ field, wire, value: buffer.readDoubleLE(offset) });
      offset += 8;
    } else if (wire === 2) {
      const [length, next] = readProtoVarint(buffer, offset);
      offset = next;
      if (length < 0 || offset + length > buffer.length) {
        throw new Error('Truncated protobuf length-delimited field');
      }
      const raw = buffer.subarray(offset, offset + length);
      fields.push({ field, wire, raw, text: raw.toString('utf8') });
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error('Truncated protobuf fixed32 field');
      fields.push({ field, wire, value: buffer.readFloatLE(offset) });
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wire}`);
    }
  }
  return fields;
}

function parseProtoTimestamp(buffer) {
  const seconds = parseProtoFields(buffer).find((field) => field.field === 1);
  if (!seconds || typeof seconds.value !== 'number') return null;
  return seconds.value * 1000;
}

function grpcFramePayload(buffer) {
  if (!buffer || buffer.length < 5) return null;
  if (buffer[0] !== 0) return null;
  const length = buffer.readUInt32BE(1);
  if (buffer.length < 5 + length) return null;
  return buffer.subarray(5, 5 + length);
}

function antigravityLogState() {
  const settings = readJson(ANTIGRAVITY_SETTINGS);
  let model = settings && typeof settings.model === 'string' ? settings.model : null;
  let modelAt = 0;
  const grpcPorts = [];
  let refreshAt = null;

  if (fs.existsSync(ANTIGRAVITY_LOG_DIR)) {
    let files = [];
    try {
      files = fs.readdirSync(ANTIGRAVITY_LOG_DIR)
        .filter((fileName) => fileName.endsWith('.log'))
        .map((fileName) => {
          const filePath = path.join(ANTIGRAVITY_LOG_DIR, fileName);
          const stat = fs.statSync(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 20);
    } catch {
      files = [];
    }

    for (const file of files) {
      let lines = [];
      try {
        lines = fs.readFileSync(file.filePath, 'utf8').split('\n');
      } catch {
        continue;
      }

      for (const line of lines) {
        if (!line) continue;
        const timestamp = antigravityLineTimestamp(line, file.mtimeMs);
        if (!timestamp) continue;

        const portMatch = /Language server listening on .* port at (\d+) for HTTPS \(gRPC\)/.exec(line);
        if (portMatch) {
          grpcPorts.push({ port: Number(portMatch[1]), timestamp });
        }

        if (/quotaRefreshLoop: starting reload /.test(line) && (!refreshAt || timestamp > refreshAt)) {
          refreshAt = timestamp;
        }

        const modelMatch = /Propagating selected model override to backend: label="([^"]+)"/.exec(line);
        if (modelMatch && timestamp > modelAt) {
          model = modelMatch[1];
          modelAt = timestamp;
        }
      }
    }
  }

  const seen = new Set();
  const ports = grpcPorts
    .sort((a, b) => b.timestamp - a.timestamp)
    .filter((item) => {
      if (seen.has(item.port)) return false;
      seen.add(item.port);
      return true;
    })
    .slice(0, 8);

  return {
    model,
    grpcPorts: ports,
    grpcPort: ports.length ? ports[0].port : null,
    grpcPortAt: ports.length ? ports[0].timestamp : 0,
    refreshAt,
  };
}

function callAntigravityQuota(port) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${port}`, {
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      client.close();
      reject(new Error('Antigravity quota request timed out'));
    }, 5000);

    client.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const request = client.request({
      ':method': 'POST',
      ':path': '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      'content-type': 'application/grpc',
      te: 'trailers',
    });
    const chunks = [];
    let responseBytes = 0;

    request.on('data', (chunk) => {
      responseBytes += chunk.length;
      if (responseBytes > 4 * 1024 * 1024) {
        request.close();
        reject(new Error('Antigravity quota response exceeded 4 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      client.close();
      reject(error);
    });
    request.on('end', () => {
      clearTimeout(timer);
      client.close();
      const payload = grpcFramePayload(Buffer.concat(chunks));
      if (!payload) {
        reject(new Error('Antigravity quota response was empty'));
        return;
      }
      resolve(payload);
    });

    request.end(Buffer.from([0, 0, 0, 0, 0]));
  });
}

function parseAntigravityBucket(raw) {
  const fields = parseProtoFields(raw);
  const text = (field) => {
    const match = fields.find((item) => item.field === field && item.wire === 2);
    return match ? match.text : null;
  };
  const remainingField = fields.find((item) => item.field === 4 && item.wire === 5);
  const resetField = fields.find((item) => item.field === 6 && item.wire === 2);
  const remaining = remainingField && Number.isFinite(remainingField.value)
    ? remainingField.value
    : null;

  return {
    id: text(1),
    label: text(2),
    window: text(3),
    remaining,
    used: remaining === null ? null : Math.max(0, Math.min(100, (1 - remaining) * 100)),
    resetAt: resetField ? parseProtoTimestamp(resetField.raw) : null,
  };
}

function parseAntigravityQuotaPayload(payload) {
  const wrapper = parseProtoFields(payload).find((field) => field.field === 1 && field.wire === 2);
  const response = wrapper ? wrapper.raw : payload;
  const fields = parseProtoFields(response);
  const groups = fields
    .filter((field) => field.field === 2 && field.wire === 2)
    .map((field) => {
      const groupFields = parseProtoFields(field.raw);
      const buckets = groupFields
        .filter((item) => item.field === 1 && item.wire === 2)
        .map((item) => parseAntigravityBucket(item.raw));
      const labelField = groupFields.find((item) => item.field === 2 && item.wire === 2);
      const label = labelField ? labelField.text : 'Antigravity';
      const five = buckets.find((bucket) => bucket.window === '5h' || /-5h$/.test(bucket.id || '')) || null;
      const weekly = buckets.find((bucket) => bucket.window === 'weekly' || /weekly/.test(bucket.id || '')) || null;
      return { label, buckets, five, seven: weekly };
    });

  return groups;
}

function chooseAntigravityGroup(groups, model) {
  if (!groups.length) return null;
  if (/claude|gpt|opus|sonnet|3p/i.test(model || '')) {
    return groups.find((group) => /claude|gpt|3p/i.test(group.label)) || groups[0];
  }
  if (/gemini/i.test(model || '')) {
    return groups.find((group) => /gemini/i.test(group.label)) || groups[0];
  }
  return groups[0];
}

function isUsableQuotaWindow(windowData) {
  return Boolean(windowData && typeof windowData.used === 'number' && Number.isFinite(windowData.used));
}

function isUsableAntigravityData(data) {
  return Boolean(data && (isUsableQuotaWindow(data.five) || isUsableQuotaWindow(data.seven)));
}

function readAntigravityCache() {
  const cached = readJson(ANTIGRAVITY_CACHE);
  if (isUsableAntigravityData(cached)) return cached;
  if (!LEGACY_ANTIGRAVITY_CACHE) return null;
  const legacy = readJson(LEGACY_ANTIGRAVITY_CACHE);
  if (!isUsableAntigravityData(legacy)) return null;
  try {
    writeJsonAtomic(ANTIGRAVITY_CACHE, legacy);
  } catch {}
  return legacy;
}

function writeAntigravityCache(data) {
  try {
    writeJsonAtomic(ANTIGRAVITY_CACHE, data);
  } catch {}
}

function readAntigravityFromCacheOrFallback(state, errorMessage) {
  const staleAfterMs = ANTIGRAVITY_STALE_MINUTES * 60000;
  const cached = readAntigravityCache();
  if (cached) {
    return {
      ...cached,
      stale: true,
      error: errorMessage,
    };
  }
  return {
    fetchedAt: state.refreshAt || null,
    five: null,
    seven: null,
    groups: [],
    model: state.model,
    activeLabel: null,
    other: null,
    source: 'antigravity-grpc',
    stale: true,
    staleAfterMs,
    error: errorMessage,
  };
}

async function readAntigravityUsage() {
  const state = antigravityLogState();
  const staleAfterMs = ANTIGRAVITY_STALE_MINUTES * 60000;
  if (!state.grpcPorts || !state.grpcPorts.length) {
    return readAntigravityFromCacheOrFallback(state, 'Antigravity CLI gRPC port not found');
  }

  let payload = null;
  let lastError = null;
  for (const candidate of state.grpcPorts) {
    try {
      payload = await callAntigravityQuota(candidate.port);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!payload) {
    return readAntigravityFromCacheOrFallback(state, lastError ? lastError.message : 'Antigravity quota gRPC request failed');
  }
  const groups = parseAntigravityQuotaPayload(payload);
  const active = chooseAntigravityGroup(groups, state.model);
  if (!active || (!isUsableQuotaWindow(active.five) && !isUsableQuotaWindow(active.seven))) {
    return readAntigravityFromCacheOrFallback(
      state,
      'Antigravity quota response did not contain usable quota buckets',
    );
  }
  const other = groups.find((group) => group !== active) || null;

  const result = {
    fetchedAt: Date.now(),
    five: active ? active.five : null,
    seven: active ? active.seven : null,
    groups,
    model: state.model,
    activeLabel: active ? active.label : null,
    other: other ? { label: other.label, five: other.five, seven: other.seven } : null,
    source: 'antigravity-grpc',
    stale: false,
    staleAfterMs,
  };

  writeAntigravityCache(result);
  return result;
}

let antigravityCache = { fetchedAt: 0, data: null, promise: null };

async function getAntigravityUsage() {
  const now = Date.now();
  if (antigravityCache.data && now - antigravityCache.fetchedAt < 15000) {
    return antigravityCache.data;
  }
  if (antigravityCache.promise) return antigravityCache.promise;

  antigravityCache.promise = readAntigravityUsage()
    .catch((error) => {
      const cached = readAntigravityCache();
      if (cached) {
        return {
          ...cached,
          stale: true,
          error: error.message,
        };
      }
      return {
        fetchedAt: null,
        five: null,
        seven: null,
        groups: [],
        model: null,
        activeLabel: null,
        other: null,
        source: 'antigravity-grpc',
        stale: true,
        staleAfterMs: ANTIGRAVITY_STALE_MINUTES * 60000,
        error: error.message,
      };
    })
    .then((data) => {
      antigravityCache = { fetchedAt: Date.now(), data, promise: null };
      return data;
    });
  return antigravityCache.promise;
}

function pageHtml() {
  return DASHBOARD_HTML;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Usage-Dashboard': '1',
};

function requestHostName(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : '';
  }
  return value.split(':')[0];
}

function writeResponse(request, response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    ...extraHeaders,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

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

function normalizeAgentSnapshot(raw, metadata = {}, now = Date.now()) {
  const id = safeAgentId(metadata.id || (raw && raw.id));
  if (!id) return null;
  const defaultStaleAfterMs = EXTERNAL_AGENT_STALE_MINUTES * 60000;
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

function readExternalAgentSnapshots(directory = EXTERNAL_AGENT_USAGE_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_EXTERNAL_AGENTS);
  } catch {
    return [];
  }

  const presets = new Map(AGENT_PRESETS.map((preset) => [preset.id, preset]));
  return entries.map((entry) => {
    const id = safeAgentId(entry.name.slice(0, -5));
    if (!id || id === 'claude' || id === 'codex' || id === 'antigravity') return null;
    const filePath = path.join(directory, entry.name);
    try {
      if (fs.statSync(filePath).size > MAX_EXTERNAL_AGENT_BYTES) return null;
    } catch {
      return null;
    }
    const raw = readJson(filePath);
    if (!raw || typeof raw !== 'object') return null;
    return normalizeAgentSnapshot(raw, presets.get(id) || { id });
  }).filter(Boolean);
}

function buildAgentCatalog(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const catalog = AGENT_PRESETS.map((preset) => {
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

function refreshKimiUsageSnapshot(options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const scriptPath = options.scriptPath || KIMI_BRIDGE_SCRIPT;
  const timeoutMs = options.timeoutMs || KIMI_BRIDGE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let stderrBuffer = '';

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve();
    };

    try {
      child = spawnImpl(process.execPath, [scriptPath], {
        cwd: os.homedir(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_NO_WARNINGS: '1',
        },
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => finish(new Error('Kimi usage bridge timed out')), timeoutMs);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      const detail = stderrBuffer.trim().slice(-300);
      finish(code === 0
        ? null
        : new Error(`Kimi usage bridge exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrBuffer = `${stderrBuffer}${chunk}`.slice(-1000);
      });
    }
  });
}

function createKimiUsageBridgeRefresher(options = {}) {
  const enabled = options.enabled !== undefined ? options.enabled : KIMI_USAGE_BRIDGE === 'auto';
  const refreshMs = options.refreshMs || KIMI_USAGE_REFRESH_MS;
  const warn = options.warn
    || ((message) => console.warn('[dashboard-server] Kimi usage bridge refresh failed:', message));
  let attemptAt = 0;
  let promise = null;
  let lastWarning = null;

  return function refreshKimiUsage(now = Date.now()) {
    if (!enabled || promise || now - attemptAt < refreshMs) return false;
    attemptAt = now;
    promise = refreshKimiUsageSnapshot(options)
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        if (message !== lastWarning) {
          warn(message);
          lastWarning = message;
        }
      })
      .finally(() => {
        promise = null;
      });
    return true;
  };
}

const kimiUsageBridgeRefresh = createKimiUsageBridgeRefresher();

async function defaultUsageProvider() {
  const claude = readClaudeUsage();
  const codex = getCodexUsage();
  const antigravity = await getAntigravityUsage();
  kimiUsageBridgeRefresh();
  const coreData = { claude, codex, antigravity };
  const agents = AGENT_PRESETS.slice(0, 3).map((preset) => (
    builtinAgentSnapshot(preset, coreData[preset.id])
  ));
  agents.push(...readExternalAgentSnapshots());
  return {
    config: {
      alertPercent: ALERT_PERCENT,
      agents: buildAgentCatalog(agents),
    },
    agents,
    claude,
    codex,
    antigravity,
  };
}

function createDashboardServer(options = {}) {
  const usageProvider = options.usageProvider || defaultUsageProvider;
  return http.createServer(async (request, response) => {
    try {
      const hostName = requestHostName(request.headers.host);
      if (!LOCAL_HOSTS.has(hostName)) {
        writeResponse(request, response, 403, 'text/plain; charset=utf-8', 'Forbidden host');
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeResponse(
          request,
          response,
          405,
          'text/plain; charset=utf-8',
          'Method not allowed',
          { Allow: 'GET, HEAD' },
        );
        return;
      }

      const requestUrl = new URL(request.url || '/', 'http://localhost');
      if (requestUrl.pathname === '/healthz') {
        writeResponse(
          request,
          response,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({ ok: true }),
        );
        return;
      }
      if (requestUrl.pathname === '/api/usage') {
        writeResponse(
          request,
          response,
          200,
          'application/json; charset=utf-8',
          JSON.stringify(await usageProvider()),
        );
        return;
      }
      if (requestUrl.pathname === '/dashboard.css') {
        writeResponse(request, response, 200, 'text/css; charset=utf-8', DASHBOARD_CSS);
        return;
      }
      if (requestUrl.pathname === '/dashboard.js') {
        writeResponse(request, response, 200, 'text/javascript; charset=utf-8', DASHBOARD_JS);
        return;
      }
      if (requestUrl.pathname === '/' && requestUrl.searchParams.get('mode') === 'desktop') {
        writeResponse(request, response, 200, 'text/html; charset=utf-8', pageHtml());
        return;
      }

      writeResponse(
        request,
        response,
        404,
        'text/plain; charset=utf-8',
        requestUrl.pathname === '/'
          ? 'Web mode has been removed. Start the desktop floating dashboard with start-dashboard-desktop.bat or npm start.'
          : 'Not found',
      );
    } catch (error) {
      console.error('[dashboard-server] request failed:', error.message);
      if (!response.headersSent) {
        writeResponse(request, response, 500, 'text/plain; charset=utf-8', 'Internal server error');
      } else {
        response.destroy();
      }
    }
  });
}

function hostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

if (require.main === module) {
  const server = createDashboardServer();
  server.listen(PORT, HOST, () => {
    const urlHost = hostForUrl(HOST);
    console.log('Claude / Codex usage dashboard');
    console.log(`Desktop: http://${urlHost}:${PORT}/?mode=desktop`);
    console.log(`API:     http://${urlHost}:${PORT}/api/usage`);
  });
}

module.exports = {
  buildAgentCatalog,
  createDashboardServer,
  createKimiUsageBridgeRefresher,
  isUsableAntigravityData,
  normalizeCodexAppServerRateLimits,
  normalizeAgentSnapshot,
  normalizeCodexRateLimits,
  pageHtml,
  parseAntigravityQuotaPayload,
  parseCodexEventLine,
  queryCodexAppServerRateLimits,
  readCodexUsage,
  readExternalAgentSnapshots,
  readLatestCodexSnapshot,
  refreshKimiUsageSnapshot,
  requestHostName,
  resolveCodexExecutable,
  writeJsonAtomic,
};
