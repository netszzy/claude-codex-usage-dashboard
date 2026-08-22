'use strict';

const fs = require('fs');
const { readJsonObject, writeJsonAtomic, writeJsonWithBackup } = require('./atomic-json');

function envNumber(name, fallback, options = {}, env = process.env) {
  const value = Number(env[name]);
  if (!Number.isFinite(value)) return fallback;
  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;
  return value;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function acquireTokenLock(lockPath, now = Date.now(), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const staleMs = options.staleMs || 30000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fsImpl.openSync(lockPath, 'wx');
      try {
        fsImpl.writeFileSync(descriptor, `${process.pid}\n`);
      } finally {
        fsImpl.closeSync(descriptor);
      }
      return true;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        try {
          if (now - fsImpl.statSync(lockPath).mtimeMs > staleMs) {
            fsImpl.unlinkSync(lockPath);
            continue;
          }
        } catch {}
      }
      return false;
    }
  }
  return false;
}

function releaseTokenLock(lockPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  try {
    fsImpl.unlinkSync(lockPath);
  } catch {}
}

function hasUsableSnapshotWindows(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const hasWindow = (windowData) => (
    windowData && typeof windowData.used === 'number' && Number.isFinite(windowData.used)
  );
  if (Array.isArray(snapshot.windows) && snapshot.windows.some(hasWindow)) return true;
  return Array.isArray(snapshot.groups) && snapshot.groups.some((group) => (
    group && Array.isArray(group.windows) && group.windows.some(hasWindow)
  ));
}

function parseCliArgs(argv, defaultIntervalSeconds, options = {}) {
  const minimum = options.minSeconds || 30;
  const maximum = options.maxSeconds || 3600;
  const args = {
    watch: false,
    intervalSeconds: defaultIntervalSeconds,
  };
  if (options.defaultWriteBack === false) args.writeBack = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--watch' || arg === '-w') {
      args.watch = true;
      const next = Number(argv[index + 1]);
      if (Number.isFinite(next) && next > 0) {
        args.intervalSeconds = Math.min(maximum, Math.max(minimum, next));
        index += 1;
      }
    } else if (arg.startsWith('--interval=')) {
      args.watch = true;
      const next = Number(arg.slice('--interval='.length));
      if (Number.isFinite(next) && next > 0) {
        args.intervalSeconds = Math.min(maximum, Math.max(minimum, next));
      }
    } else if (arg === '--once') {
      args.watch = false;
    } else if (arg === '--no-write-back') {
      args.writeBack = false;
    }
  }
  return args;
}

function runWatchLoop(runOnce, args, options = {}) {
  const setIntervalFn = options.setIntervalFn || setInterval;
  return runOnce().then((result) => {
    if (!args.watch) {
      process.exitCode = result && result.ok ? 0 : 1;
      return null;
    }
    return setIntervalFn(() => {
      runOnce().catch(() => {});
    }, args.intervalSeconds * 1000);
  });
}

async function runSnapshotOnce(options) {
  const {
    buildSnapshot,
    fetchUsage,
    label,
    logger,
    snapshotPath,
    source,
    staleAfterMs,
    summarize,
  } = options;
  const now = options.now || (() => Date.now());
  try {
    const payload = await fetchUsage();
    const snapshot = buildSnapshot(payload, now());
    writeJsonAtomic(snapshotPath, snapshot);
    const summary = typeof summarize === 'function' ? summarize(snapshot) : '';
    logger(`updated ${snapshotPath}${summary ? `: ${summary}` : ''}`);
    return { ok: true, snapshot };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const existing = readJsonObject(snapshotPath);
    if (hasUsableSnapshotWindows(existing)) {
      logger(`refresh failed (${message}); keeping last good snapshot`);
      return { ok: false, keptLastGood: true, error: message };
    }
    const stub = {
      label,
      source,
      fetchedAt: now(),
      stale: true,
      staleAfterMs,
      error: message,
      windows: [],
      ...(options.includeGroups ? { groups: [] } : {}),
    };
    try {
      writeJsonAtomic(snapshotPath, stub);
    } catch {}
    logger(`refresh failed (${message}); no previous snapshot available`);
    return { ok: false, keptLastGood: false, error: message };
  }
}

function warnSkipWriteBack(warn, message) {
  if (typeof warn === 'function') warn(message);
}

function writeCredentialWithBackup(filePath, buildNext, validate, options = {}) {
  if (options.writeBack === false) {
    return { written: false, reason: 'disabled' };
  }
  const current = readJsonObject(filePath, options);
  const reason = typeof validate === 'function' ? validate(current) : null;
  if (reason) {
    warnSkipWriteBack(options.warn, `credential write-back skipped: ${reason}`);
    return { written: false, reason };
  }
  try {
    const next = buildNext(current);
    writeJsonWithBackup(filePath, next, options);
    return { written: true, value: next };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    warnSkipWriteBack(options.warn, `credential write-back skipped: ${message}`);
    return { written: false, reason: message };
  }
}

module.exports = {
  acquireTokenLock,
  envNumber,
  hasUsableSnapshotWindows,
  parseCliArgs,
  readJsonObject,
  releaseTokenLock,
  runSnapshotOnce,
  runWatchLoop,
  timestampMs,
  writeCredentialWithBackup,
  writeJsonAtomic,
};
