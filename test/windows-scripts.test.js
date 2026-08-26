'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('PowerShell shortcut scripts parse without syntax errors', { skip: process.platform !== 'win32' }, () => {
  for (const fileName of ['manage-desktop-shortcuts.ps1', 'start-dashboard-complete.ps1']) {
    const scriptPath = path.join(__dirname, '..', fileName).replace(/'/g, "''");
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

    assert.equal(result.status, 0, `${fileName}: ${result.stderr}`);
  }
});

test('desktop starter prefers a current packaged application before portable and Electron development files', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start-dashboard-desktop.bat'), 'utf8');
  const unpackedIndex = source.indexOf('release\\win-unpacked\\AI Usage Dashboard.exe');
  const portableIndex = source.indexOf('release\\AI-Usage-Dashboard-*-portable.exe');
  const electronIndex = source.indexOf('node_modules\\electron\\dist\\electron.exe');
  assert.ok(unpackedIndex >= 0);
  assert.ok(portableIndex >= 0);
  assert.ok(electronIndex >= 0);
  assert.ok(unpackedIndex < portableIndex);
  assert.ok(portableIndex < electronIndex);
  assert.match(source, /for %%F in \("%~dp0release\\AI-Usage-Dashboard-\*-portable\.exe"\)/);
});

test('hidden desktop runners delegate to the packaged desktop starter', () => {
  for (const fileName of ['run-desktop-hidden.vbs', 'run-hidden.vbs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8');
    assert.match(source, /start-dashboard-desktop\.bat/);
    assert.doesNotMatch(source, /node_modules\\electron\\dist\\electron\.exe/);
  }
});

test('desktop shortcut runner starts complete phone mode and verifies both local services', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'run-dashboard-complete.vbs'), 'utf8');
  const starter = fs.readFileSync(path.join(__dirname, '..', 'start-dashboard-complete.ps1'), 'utf8');
  const manager = fs.readFileSync(path.join(__dirname, '..', 'manage-desktop-shortcuts.ps1'), 'utf8');
  assert.match(runner, /start-dashboard-complete\.ps1/);
  assert.match(starter, /start-dashboard-phone\.bat/);
  assert.match(starter, /127\.0\.0\.1:8787\/healthz/);
  assert.match(starter, /127\.0\.0\.1:8787\/api\/usage/);
  assert.match(starter, /127\.0\.0\.1:8788\/phone\//);
  assert.match(manager, /\$targetRunner = if \(\$location\.Name -eq 'desktop'\) \{ \$fullRunner \} else \{ \$runner \}/);
  assert.match(runner, /^[\x00-\x7F]*$/);
});

test('phone starter prefers a current packaged application and requests phone mode', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start-dashboard-phone.bat'), 'utf8');
  const unpackedIndex = source.indexOf('release\\win-unpacked\\AI Usage Dashboard.exe');
  const portableIndex = source.indexOf('release\\AI-Usage-Dashboard-*-portable.exe');
  const electronIndex = source.indexOf('node_modules\\electron\\dist\\electron.exe');
  assert.ok(unpackedIndex >= 0);
  assert.ok(portableIndex >= 0);
  assert.ok(electronIndex >= 0);
  assert.ok(unpackedIndex < portableIndex);
  assert.ok(portableIndex < electronIndex);
  assert.match(source, /for %%F in \("%~dp0release\\AI-Usage-Dashboard-\*-portable\.exe"\)/);
  assert.match(source, /--phone-display/);
});

test('Windows package unpacks the local dashboard service runtime', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const unpacked = packageJson.build.asarUnpack;
  assert.ok(unpacked.includes('server.js'));
  assert.ok(unpacked.includes('lib/**/*'));
  assert.ok(unpacked.includes('phone-display.js'));
});
