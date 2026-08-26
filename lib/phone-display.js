'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readJsonObject, writeJsonAtomic } = require('./atomic-json');

const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING_CODE_PATTERN = /^(?:[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-){2}[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function phoneDisplayEnabled(value = process.env.PHONE_DISPLAY) {
  if (value === undefined || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'on') return true;
  if (normalized === 'off') return false;
  throw new Error('PHONE_DISPLAY must be on or off');
}

function hasPhoneDisplayLaunchArgument(args) {
  return Array.isArray(args) && args.includes('--phone-display');
}

function phoneDisplayPort(value = process.env.PHONE_DISPLAY_PORT) {
  if (value === undefined || value === '') return 8788;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PHONE_DISPLAY_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function phoneDisplayHost(value = process.env.PHONE_DISPLAY_HOST) {
  if (value === undefined || value === '') return '0.0.0.0';
  if (value === '0.0.0.0' || value === '127.0.0.1') return value;
  throw new Error('PHONE_DISPLAY_HOST must be 0.0.0.0 or 127.0.0.1');
}

function createPairingCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(12);
  let code = '';
  for (let index = 0; index < 12; index += 1) {
    code += PAIRING_ALPHABET[bytes[index] & 31];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

function isValidAccess(access) {
  return Boolean(
    access
      && typeof access === 'object'
      && ACCESS_TOKEN_PATTERN.test(access.token || '')
      && PAIRING_CODE_PATTERN.test(access.pairingCode || ''),
  );
}

function createPhoneDisplayAccess(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || env.PHONE_DISPLAY_CONFIG_PATH
    || path.join(os.homedir(), '.claude-codex-usage-dashboard', 'phone-display.json');
  const stored = readJsonObject(configPath);
  if (isValidAccess(stored)) {
    return { configPath, token: stored.token, pairingCode: stored.pairingCode };
  }

  const randomBytes = options.randomBytes || crypto.randomBytes;
  const access = {
    token: randomBytes(32).toString('base64url'),
    pairingCode: createPairingCode(randomBytes),
  };
  writeJsonAtomic(configPath, access, { trailingNewline: true });
  return { configPath, ...access };
}

function secureEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header) {
  const cookies = {};
  for (const entry of String(header || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (name && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

function normalizeRemoteAddress(address) {
  const value = String(address || '').toLowerCase();
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function isPrivateIpv4Address(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivatePeerAddress(address) {
  const normalized = normalizeRemoteAddress(address);
  return normalized === '::1' || isPrivateIpv4Address(normalized);
}

function phoneDisplayAddresses(networkInterfaces = os.networkInterfaces()) {
  const addresses = new Set();
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4' || !isPrivateIpv4Address(entry.address)) continue;
      if (!entry.address.startsWith('127.')) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function phoneDisplayUrls(port, networkInterfaces) {
  return phoneDisplayAddresses(networkInterfaces).map((address) => `http://${address}:${port}/phone/`);
}

function phoneDisplaySettings(options = {}) {
  const env = options.env || process.env;
  const enabled = phoneDisplayEnabled(env.PHONE_DISPLAY);
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    host: phoneDisplayHost(env.PHONE_DISPLAY_HOST),
    port: phoneDisplayPort(env.PHONE_DISPLAY_PORT),
    access: createPhoneDisplayAccess({ env, configPath: options.configPath, randomBytes: options.randomBytes }),
  };
}

module.exports = {
  ACCESS_TOKEN_PATTERN,
  PAIRING_CODE_PATTERN,
  createPairingCode,
  createPhoneDisplayAccess,
  isPrivateIpv4Address,
  isPrivatePeerAddress,
  isValidAccess,
  hasPhoneDisplayLaunchArgument,
  normalizeRemoteAddress,
  parseCookies,
  phoneDisplayAddresses,
  phoneDisplayEnabled,
  phoneDisplayHost,
  phoneDisplayPort,
  phoneDisplaySettings,
  phoneDisplayUrls,
  secureEquals,
};
