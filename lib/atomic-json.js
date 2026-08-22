'use strict';

const fs = require('fs');
const path = require('path');

function readJsonObject(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const indent = options.indent === undefined ? 2 : options.indent;
  const trailingNewline = options.trailingNewline === true ? '\n' : '';
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  fsImpl.mkdirSync(directory, { recursive: true });
  try {
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, indent)}${trailingNewline}`, 'utf8');
    fsImpl.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fsImpl.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function backupFile(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const backupPath = options.backupPath || `${filePath}.bak`;
  fsImpl.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeJsonWithBackup(filePath, value, options = {}) {
  const backupPath = backupFile(filePath, options);
  writeJsonAtomic(filePath, value, options);
  return backupPath;
}

module.exports = {
  backupFile,
  readJsonObject,
  writeJsonAtomic,
  writeJsonWithBackup,
};
