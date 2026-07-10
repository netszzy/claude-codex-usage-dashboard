'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDirectory = path.join(root, 'node_modules', 'electron');
const packagePath = path.join(electronDirectory, 'package.json');
const installerPath = path.join(electronDirectory, 'install.js');
const pathFile = path.join(electronDirectory, 'path.txt');

function installedBinary() {
  if (!fs.existsSync(packagePath) || !fs.existsSync(pathFile)) return null;
  const relativePath = fs.readFileSync(pathFile, 'utf8').trim();
  if (!relativePath) return null;
  const binaryPath = path.join(electronDirectory, 'dist', relativePath);
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

const currentBinary = installedBinary();
if (currentBinary) {
  console.log(`Electron binary ready: ${currentBinary}`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error('Electron package exists but its binary is missing. Run npm install.');
  process.exit(1);
}

if (!fs.existsSync(installerPath)) {
  console.error('Electron installer is missing: ' + installerPath);
  process.exit(1);
}

const result = spawnSync(process.execPath, [installerPath], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.status !== 0 || !installedBinary()) {
  console.error('Electron binary installation failed.');
  process.exit(result.status || 1);
}

console.log('Electron binary installed successfully.');
