'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseCommandLine } = require('./lib/command-line');

const OUR_STATUSLINE = path.join(__dirname, 'statusline-usage.js');
const CONFIG_PATH = process.env.STATUSLINE_CONFIG_PATH || path.join(__dirname, 'config.json');

function loadConfig(configPath = CONFIG_PATH) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function runCommand(command, args, input, options = {}) {
  try {
    return spawnSync(command, args, {
      input,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      shell: false,
      ...options,
    });
  } catch {
    return null;
  }
}

function runExtraStatusline(command, input, options = {}) {
  const allowShell = options.allowShell === true;
  const stderr = options.stderr || process.stderr;
  const text = String(command || '').trim();
  if (!text) return { ran: false };

  if (allowShell) {
    stderr.write(`[statusline-both] --allow-shell enabled; executing: ${text}\n`);
    return { ran: true, result: runCommand(text, [], input, { shell: true }) };
  }

  try {
    const [executable, ...args] = parseCommandLine(text);
    return { ran: true, result: runCommand(executable, args, input) };
  } catch (error) {
    stderr.write(`[statusline-both] extra statusLine command was not run: ${error.message}\n`);
    return { ran: false, error };
  }
}

function main(options = {}) {
  const config = loadConfig(options.configPath || CONFIG_PATH);
  const extraCommand = options.extraCommand === undefined
    ? process.env.EXTRA_STATUSLINE_COMMAND || config.extraStatuslineCommand || ''
    : options.extraCommand;
  const allowShell = options.allowShell === undefined
    ? process.argv.includes('--allow-shell')
    : options.allowShell;
  let input = '';
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    input += chunk;
  });
  stdin.on('end', () => {
    const own = runCommand(process.execPath, [OUR_STATUSLINE], input);
    runExtraStatusline(extraCommand, input, { allowShell, stderr: options.stderr || process.stderr });
    const output = own && own.stdout ? own.stdout.trim() : 'Claude';
    stdout.write(output);
  });
}

if (require.main === module) main();

module.exports = {
  loadConfig,
  main,
  runCommand,
  runExtraStatusline,
};
