'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeJsonAtomic } = require('./lib/atomic-json');

const useFanout = process.argv.includes('--fanout');
const settingsPath = process.env.CLAUDE_SETTINGS_PATH
  || path.join(os.homedir(), '.claude', 'settings.json');
const configPath = process.env.STATUSLINE_CONFIG_PATH
  || path.join(__dirname, 'config.json');
const scriptName = useFanout ? 'statusline-both.js' : 'statusline-usage.js';
const scriptPath = path.join(__dirname, scriptName);

function quote(value) {
  const text = String(value);
  if (text.includes('"')) throw new Error('Command paths cannot contain double quotes');
  return '"' + text + '"';
}

function backupPathFor(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return filePath + '.bak-' + stamp;
}

function readJsonFile(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) || fallback;
  } catch {
    throw new Error('Failed to parse JSON: ' + filePath);
  }
}

function backupFile(filePath) {
  const backupPath = backupPathFor(filePath);
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function isDashboardStatusline(command) {
  const normalized = String(command || '').toLowerCase();
  return normalized.includes('statusline-usage.js') || normalized.includes('statusline-both.js');
}

function printHelp() {
  console.log('Usage: node setup-statusline.js [--fanout]');
  console.log('');
  console.log('--fanout  Preserve an existing statusLine command through statusline-both.js.');
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const settingsExists = fs.existsSync(settingsPath);
  const settings = readJsonFile(settingsPath);
  const previousCommand = settings.statusLine && typeof settings.statusLine.command === 'string'
    ? settings.statusLine.command
    : '';

  if (previousCommand && !isDashboardStatusline(previousCommand) && !useFanout) {
    throw new Error(
      'An existing statusLine command is configured. Re-run with --fanout to preserve it.',
    );
  }

  if (useFanout && previousCommand && !isDashboardStatusline(previousCommand)) {
    const configExists = fs.existsSync(configPath);
    const config = readJsonFile(configPath);
    if (
      config.extraStatuslineCommand
      && config.extraStatuslineCommand !== previousCommand
    ) {
      throw new Error(
        'config.json already contains a different extraStatuslineCommand. Review it before continuing.',
      );
    }
    config.extraStatuslineCommand = previousCommand;
    if (configExists) {
      const configBackup = backupFile(configPath);
      console.log('Backed up existing fanout config to:');
      console.log('  ' + configBackup);
    }
    writeJsonAtomic(configPath, config, { trailingNewline: true });
  }

  if (settingsExists) {
    const settingsBackup = backupFile(settingsPath);
    console.log('Backed up existing settings to:');
    console.log('  ' + settingsBackup);
  }

  const command = quote(process.execPath) + ' ' + quote(scriptPath);
  settings.statusLine = {
    type: 'command',
    command,
    padding: 0,
  };
  writeJsonAtomic(settingsPath, settings, { trailingNewline: true });

  console.log('');
  console.log('Claude Code statusLine is now configured:');
  console.log('  ' + command);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart Claude Code completely.');
  console.log('  2. Send one message in Claude Code.');
  console.log('  3. The dashboard will refresh automatically.');
  if (useFanout) {
    console.log('');
    console.log('Fanout mode is enabled.');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  backupFile,
  isDashboardStatusline,
  main,
  writeJsonAtomic,
};
