'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const setupScript = path.join(__dirname, '..', 'setup-statusline.js');
const statuslineScript = path.join(__dirname, '..', 'statusline-usage.js');

function runSetup(argumentsList, environment) {
  return spawnSync(process.execPath, [setupScript, ...argumentsList], {
    env: { ...process.env, ...environment },
    encoding: 'utf8',
  });
}

test('setup refuses to overwrite an unrelated statusLine without fanout', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, 'settings.json');
  const configPath = path.join(directory, 'config.json');
  const original = JSON.stringify({
    statusLine: { type: 'command', command: 'custom-statusline.exe --mode compact' },
  }, null, 2);
  fs.writeFileSync(settingsPath, original, 'utf8');

  const result = runSetup([], {
    CLAUDE_SETTINGS_PATH: settingsPath,
    STATUSLINE_CONFIG_PATH: configPath,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Re-run with --fanout/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
});

test('fanout preserves the previous command and creates a mandatory backup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-fanout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, 'settings.json');
  const configPath = path.join(directory, 'config.json');
  const previousCommand = 'custom-statusline.exe --mode compact';
  fs.writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: previousCommand },
  }), 'utf8');

  const result = runSetup(['--fanout'], {
    CLAUDE_SETTINGS_PATH: settingsPath,
    STATUSLINE_CONFIG_PATH: configPath,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).extraStatuslineCommand, previousCommand);
  assert.match(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).statusLine.command, /statusline-both\.js/);
  assert.equal(
    fs.readdirSync(directory).filter((name) => name.startsWith('settings.json.bak-')).length,
    1,
  );
});

test('statusline cache writes are atomic and the alert threshold controls ANSI red', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-dashboard-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'usage-cache.json');
  const input = JSON.stringify({
    model: { display_name: 'Claude Test' },
    rate_limits: {
      five_hour: { used_percentage: 40 },
      seven_day: { used_percentage: 20 },
    },
  });
  const result = spawnSync(process.execPath, [statuslineScript], {
    env: { ...process.env, CLAUDE_USAGE_CACHE: cachePath, ALERT_PERCENT: '40' },
    input,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\u001b\[38;2;255;0;0m40%/);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf8')).rate_limits.five_hour.used_percentage, 40);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
});
