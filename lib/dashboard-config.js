'use strict';

const os = require('os');
const path = require('path');
const { readJsonObject, writeJsonAtomic } = require('./atomic-json');

const DEFAULT_CONFIG = Object.freeze({
  alertPercent: 85,
  bridges: Object.freeze({ kimi: true, grok: true }),
});

function envNumber(name, fallback, options = {}, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  if (options.integer && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  if (options.min !== undefined && value < options.min) throw new Error(`${name} must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new Error(`${name} must be at most ${options.max}`);
  return value;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function bridgeEnvOverride(name, env = process.env) {
  if (!hasOwn(env, name)) return null;
  const value = String(env[name] || '').trim().toLowerCase();
  if (value === 'auto') return true;
  if (value === 'off') return false;
  throw new Error(`${name} must be auto or off`);
}

function normalizedStoredConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bridges = source.bridges && typeof source.bridges === 'object' && !Array.isArray(source.bridges)
    ? source.bridges
    : {};
  return {
    alertPercent: typeof source.alertPercent === 'number'
      && Number.isFinite(source.alertPercent)
      && source.alertPercent >= 50
      && source.alertPercent <= 95
      ? source.alertPercent
      : DEFAULT_CONFIG.alertPercent,
    bridges: {
      kimi: typeof bridges.kimi === 'boolean' ? bridges.kimi : DEFAULT_CONFIG.bridges.kimi,
      grok: typeof bridges.grok === 'boolean' ? bridges.grok : DEFAULT_CONFIG.bridges.grok,
    },
  };
}

function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('配置必须是 JSON 对象');
  }
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error('配置不能为空');
  for (const key of keys) {
    if (key !== 'alertPercent' && key !== 'bridges') throw new Error(`不允许配置字段：${key}`);
  }
  if (hasOwn(patch, 'alertPercent')) {
    if (!Number.isInteger(patch.alertPercent) || patch.alertPercent < 50 || patch.alertPercent > 95) {
      throw new Error('告警阈值必须是 50 到 95 的整数');
    }
  }
  if (hasOwn(patch, 'bridges')) {
    if (!patch.bridges || typeof patch.bridges !== 'object' || Array.isArray(patch.bridges)) {
      throw new Error('桥接设置必须是对象');
    }
    for (const key of Object.keys(patch.bridges)) {
      if (key !== 'kimi' && key !== 'grok') throw new Error(`不允许桥接字段：${key}`);
      if (typeof patch.bridges[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    }
  }
}

function createDashboardConfig(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || env.DASHBOARD_CONFIG_PATH
    || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'dashboard-config.json');
  const alertOverride = hasOwn(env, 'ALERT_PERCENT')
    ? envNumber('ALERT_PERCENT', DEFAULT_CONFIG.alertPercent, { min: 0, max: 100 }, env)
    : null;
  const bridgeOverrides = {
    kimi: bridgeEnvOverride('KIMI_USAGE_BRIDGE', env),
    grok: bridgeEnvOverride('GROK_USAGE_BRIDGE', env),
  };
  let stored = normalizedStoredConfig(readJsonObject(configPath));

  function getConfig() {
    return {
      alertPercent: alertOverride === null ? stored.alertPercent : alertOverride,
      bridges: {
        kimi: bridgeOverrides.kimi === null ? stored.bridges.kimi : bridgeOverrides.kimi,
        grok: bridgeOverrides.grok === null ? stored.bridges.grok : bridgeOverrides.grok,
      },
    };
  }

  function update(patch) {
    validateConfigPatch(patch);
    stored = {
      alertPercent: hasOwn(patch, 'alertPercent') ? patch.alertPercent : stored.alertPercent,
      bridges: {
        ...stored.bridges,
        ...(patch.bridges || {}),
      },
    };
    writeJsonAtomic(configPath, stored, { trailingNewline: true });
    return getConfig();
  }

  return {
    configPath,
    getConfig,
    update,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  bridgeEnvOverride,
  createDashboardConfig,
  envNumber,
  normalizedStoredConfig,
  validateConfigPatch,
};
