'use strict';

const path = require('path');
const os = require('os');
const { writeJsonAtomic } = require('./lib/atomic-json');

const CACHE_PATH = process.env.CLAUDE_USAGE_CACHE
  || path.join(os.homedir(), '.claude', 'usage-cache.json');
const alertValue = Number(process.env.ALERT_PERCENT);
const ALERT_PERCENT = Number.isFinite(alertValue) && alertValue >= 0 && alertValue <= 100
  ? alertValue
  : 85;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  let session = {};
  try {
    session = JSON.parse(input) || {};
  } catch (error) {}

  const rateLimits = session.rate_limits || null;
  if (rateLimits) {
    try {
      writeJsonAtomic(CACHE_PATH, {
        fetchedAt: Date.now(),
        rate_limits: rateLimits,
      }, { indent: 0 });
    } catch (error) {}
  }

  let line = 'Claude';
  try {
    const fiveHour = rateLimits && rateLimits.five_hour;
    const sevenDay = rateLimits && rateLimits.seven_day;
    const percent = (value) => {
      if (typeof value !== 'number') return '--';
      const p = Math.max(0, Math.min(100, Math.round(value)));
      if (p >= ALERT_PERCENT) return `\x1b[38;2;255;0;0m${p}%\x1b[0m`;
      if (p < 50) return `${p}%`;
      const r = 255;
      const b = 0;
      const g = Math.round(230 - (Math.max(0, p - 50) / Math.max(1, ALERT_PERCENT - 50)) * 140);
      return `\x1b[38;2;${r};${g};${b}m${p}%\x1b[0m`;
    };
    const model = (session.model && (session.model.display_name || session.model.id)) || 'Claude';
    line = (fiveHour || sevenDay)
      ? model + '  5h used ' + percent(fiveHour && fiveHour.used_percentage)
        + ' · 7d used ' + percent(sevenDay && sevenDay.used_percentage)
      : model;
  } catch (error) {}

  process.stdout.write(line);
});
