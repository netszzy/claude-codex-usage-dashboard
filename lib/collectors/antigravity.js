'use strict';

const fsPromises = require('fs/promises');
const http2 = require('http2');
const os = require('os');
const path = require('path');
const { readJsonObject, writeJsonAtomic } = require('../atomic-json');
const { envNumber } = require('../dashboard-config');

function antigravityLineTimestamp(line, fileTimeMs) {
  const match = /(?:^|:\s*)[IWEF](\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(line);
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

function readProtoVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let position = offset;
  let bytes = 0;
  while (position < buffer.length && bytes < 10) {
    const byte = buffer[position];
    position += 1;
    bytes += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Protobuf varint exceeds the safe integer range');
      }
      return [Number(value), position];
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

function dedupePorts(ports) {
  const seen = new Set();
  return ports
    .filter((entry) => entry && Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535)
    .sort((left, right) => right.timestamp - left.timestamp)
    .filter((entry) => {
      if (seen.has(entry.port)) return false;
      seen.add(entry.port);
      return true;
    })
    .slice(0, 8);
}

function parseLogText(text, fileTimeMs, prior = {}) {
  const record = {
    ports: Array.isArray(prior.ports) ? prior.ports.slice() : [],
    model: prior.model || null,
    modelAt: prior.modelAt || 0,
    refreshAt: prior.refreshAt || null,
  };
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const timestamp = antigravityLineTimestamp(line, fileTimeMs);
    if (!timestamp) continue;
    const portMatch = /Language server listening on .* port at (\d+) for HTTPS \(gRPC\)/.exec(line);
    if (portMatch) record.ports.push({ port: Number(portMatch[1]), timestamp });
    if (/quotaRefreshLoop: starting reload /.test(line) && (!record.refreshAt || timestamp > record.refreshAt)) {
      record.refreshAt = timestamp;
    }
    const modelMatch = /Propagating selected model override to backend: label="([^"]+)"/.exec(line);
    if (modelMatch && timestamp > record.modelAt) {
      record.model = modelMatch[1];
      record.modelAt = timestamp;
    }
  }
  record.ports = dedupePorts(record.ports);
  return record;
}

async function readJsonObjectAsync(filePath, promises = fsPromises) {
  try {
    const value = JSON.parse(await promises.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function readLogAppend(filePath, start, size, options = {}) {
  const promises = options.fsPromises || fsPromises;
  const overlapBytes = options.overlapBytes || 8192;
  if (size <= start) return '';
  const position = start > 0 ? Math.max(0, start - overlapBytes) : 0;
  const length = size - position;
  const handle = await promises.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (!position) return text;
    const newline = text.indexOf('\n');
    return newline >= 0 ? text.slice(newline + 1) : '';
  } finally {
    await handle.close();
  }
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
  return fields
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

function callAntigravityQuota(port) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Antigravity quota request timed out')), 5000);
    client.on('error', (error) => finish(error));
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
        finish(new Error('Antigravity quota response exceeded 4 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error) => finish(error));
    request.on('end', () => {
      const payload = grpcFramePayload(Buffer.concat(chunks));
      if (!payload) {
        finish(new Error('Antigravity quota response was empty'));
        return;
      }
      finish(null, payload);
    });
    request.end(Buffer.from([0, 0, 0, 0, 0]));
  });
}

function cleanLogState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ports = dedupePorts(Array.isArray(raw.grpcPorts) ? raw.grpcPorts : []);
  if (!ports.length) return null;
  return {
    model: typeof raw.model === 'string' ? raw.model : null,
    grpcPorts: ports,
    refreshAt: typeof raw.refreshAt === 'number' && Number.isFinite(raw.refreshAt) ? raw.refreshAt : null,
  };
}

function createAntigravityCollector(options = {}) {
  const env = options.env || process.env;
  const logDirectory = options.logDirectory || env.ANTIGRAVITY_LOG_DIR
    || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
  const settingsPath = options.settingsPath || env.ANTIGRAVITY_SETTINGS
    || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  const cachePath = options.cachePath || env.ANTIGRAVITY_USAGE_CACHE
    || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'antigravity-usage-cache.json');
  const legacyCachePath = options.legacyCachePath === undefined
    ? (env.ANTIGRAVITY_USAGE_CACHE ? null : path.join(os.homedir(), '.claude', 'antigravity-usage-cache.json'))
    : options.legacyCachePath;
  const staleMinutes = options.staleMinutes === undefined
    ? envNumber('ANTIGRAVITY_STALE_MINUTES', 120, { min: 0 }, env)
    : options.staleMinutes;
  const staleAfterMs = Math.max(0, staleMinutes) * 60000;
  const maxLogFiles = options.maxLogFiles || 3;
  const promises = options.fsPromises || fsPromises;
  const now = options.now || Date.now;
  const quotaRequest = options.callQuota || callAntigravityQuota;
  const logRecords = new Map();
  let antigravityCache = { fetchedAt: 0, data: null, promise: null };

  function splitCachedRecord(record) {
    if (!record || typeof record !== 'object') return { data: null, logState: null };
    const { _logState, ...data } = record;
    return {
      data: isUsableAntigravityData(data) ? data : null,
      logState: cleanLogState(_logState),
    };
  }

  function readAntigravityCacheRecord() {
    const current = splitCachedRecord(readJsonObject(cachePath));
    if (current.data) return current;
    if (!legacyCachePath) return current;
    const legacy = splitCachedRecord(readJsonObject(legacyCachePath));
    if (!legacy.data) return current;
    try {
      writeJsonAtomic(cachePath, {
        ...legacy.data,
        _logState: legacy.logState,
      });
    } catch {}
    return legacy;
  }

  function readAntigravityCache() {
    return readAntigravityCacheRecord().data;
  }

  function writeAntigravityCache(data, logState) {
    try {
      writeJsonAtomic(cachePath, {
        ...data,
        _logState: cleanLogState(logState),
      });
    } catch {}
  }

  async function antigravityLogState() {
    const settings = await readJsonObjectAsync(settingsPath, promises);
    let model = settings && typeof settings.model === 'string' ? settings.model : null;
    let modelAt = 0;
    let files = [];
    try {
      const entries = await promises.readdir(logDirectory, { withFileTypes: true });
      const stats = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .map(async (entry) => {
          const filePath = path.join(logDirectory, entry.name);
          try {
            const stat = await promises.stat(filePath);
            return { filePath, size: stat.size, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }));
      files = stats.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, maxLogFiles);
    } catch {
      files = [];
    }

    const activePaths = new Set(files.map((file) => file.filePath));
    for (const filePath of logRecords.keys()) {
      if (!activePaths.has(filePath)) logRecords.delete(filePath);
    }

    for (const file of files) {
      const previous = logRecords.get(file.filePath);
      const mustReadAll = !previous
        || file.size < previous.size
        || (file.size === previous.size && file.mtimeMs !== previous.mtimeMs);
      if (!mustReadAll && file.size === previous.size) continue;
      const start = mustReadAll ? 0 : previous.size;
      try {
        const text = await readLogAppend(file.filePath, start, file.size, { fsPromises: promises });
        const parsed = parseLogText(text, file.mtimeMs, mustReadAll ? {} : previous);
        logRecords.set(file.filePath, { ...parsed, size: file.size, mtimeMs: file.mtimeMs });
      } catch {}
    }

    let ports = dedupePorts(Array.from(logRecords.values()).flatMap((record) => record.ports || []));
    let refreshAt = null;
    for (const record of logRecords.values()) {
      if (record.model && record.modelAt > modelAt) {
        model = record.model;
        modelAt = record.modelAt;
      }
      if (record.refreshAt && (!refreshAt || record.refreshAt > refreshAt)) refreshAt = record.refreshAt;
    }

    if (!ports.length) {
      const fallback = readAntigravityCacheRecord().logState;
      if (fallback) {
        ports = fallback.grpcPorts;
        if (!model && fallback.model) model = fallback.model;
        if (!refreshAt) refreshAt = fallback.refreshAt;
      }
    }
    return {
      model,
      grpcPorts: ports,
      grpcPort: ports.length ? ports[0].port : null,
      grpcPortAt: ports.length ? ports[0].timestamp : 0,
      refreshAt,
    };
  }

  function readAntigravityFromCacheOrFallback(state, errorMessage) {
    const cached = readAntigravityCache();
    if (cached) return { ...cached, stale: true, error: errorMessage };
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
    const state = await antigravityLogState();
    if (!state.grpcPorts.length) {
      return readAntigravityFromCacheOrFallback(state, 'Antigravity CLI gRPC port not found');
    }
    let payload = null;
    let lastError = null;
    for (const candidate of state.grpcPorts) {
      try {
        payload = await quotaRequest(candidate.port);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payload) {
      return readAntigravityFromCacheOrFallback(
        state,
        lastError ? lastError.message : 'Antigravity quota gRPC request failed',
      );
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
      fetchedAt: now(),
      five: active.five,
      seven: active.seven,
      groups,
      model: state.model,
      activeLabel: active.label,
      other: other ? { label: other.label, five: other.five, seven: other.seven } : null,
      source: 'antigravity-grpc',
      stale: false,
      staleAfterMs,
    };
    writeAntigravityCache(result, state);
    return result;
  }

  async function getAntigravityUsage() {
    const current = now();
    if (antigravityCache.data && current - antigravityCache.fetchedAt < 15000) {
      return antigravityCache.data;
    }
    if (antigravityCache.promise) return antigravityCache.promise;
    antigravityCache.promise = readAntigravityUsage()
      .catch((error) => {
        const cached = readAntigravityCache();
        if (cached) return { ...cached, stale: true, error: error.message };
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
          staleAfterMs,
          error: error.message,
        };
      })
      .then((data) => {
        antigravityCache = { fetchedAt: now(), data, promise: null };
        return data;
      });
    return antigravityCache.promise;
  }

  return {
    antigravityLogState,
    getAntigravityUsage,
    readAntigravityUsage,
    readAntigravityCache,
  };
}

const defaultCollector = createAntigravityCollector();

module.exports = {
  antigravityLineTimestamp,
  antigravityLogState: defaultCollector.antigravityLogState,
  callAntigravityQuota,
  chooseAntigravityGroup,
  createAntigravityCollector,
  getAntigravityUsage: defaultCollector.getAntigravityUsage,
  grpcFramePayload,
  isUsableAntigravityData,
  isUsableQuotaWindow,
  parseAntigravityBucket,
  parseAntigravityQuotaPayload,
  parseProtoFields,
  readAntigravityUsage: defaultCollector.readAntigravityUsage,
  readProtoVarint,
};
