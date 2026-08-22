'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('PowerShell shortcut manager parses without syntax errors', { skip: process.platform !== 'win32' }, () => {
  const scriptPath = path.join(__dirname, '..', 'manage-desktop-shortcuts.ps1').replace(/'/g, "''");
  const command = [
    '$tokens=$null',
    '$errors=$null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}',[ref]$tokens,[ref]$errors)|Out-Null`,
    'if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 1}',
  ].join(';');
  const result = spawnSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe', [
    '-NoLogo',
    '-NoProfile',
    '-Command',
    command,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
});

test('desktop starter prefers a packaged portable executable before Electron development files', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start-dashboard-desktop.bat'), 'utf8');
  const portableIndex = source.indexOf('release\\AI-Usage-Dashboard-*-portable.exe');
  const electronIndex = source.indexOf('node_modules\\electron\\dist\\electron.exe');
  assert.ok(portableIndex >= 0);
  assert.ok(electronIndex >= 0);
  assert.ok(portableIndex < electronIndex);
});
