'use strict';

const os = require('os');
const { spawn } = require('child_process');

function refreshBridgeSnapshot(definition, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const scriptPath = options.scriptPath || definition.scriptPath;
  const timeoutMs = options.timeoutMs || definition.timeoutMs || 30000;
  const label = definition.label || definition.id;
  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let stderrBuffer = '';
    let timer = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve();
    };

    try {
      child = spawnImpl(process.execPath, [scriptPath], {
        cwd: options.cwd || os.homedir(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_NO_WARNINGS: '1',
        },
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    timer = setTimeout(() => finish(new Error(`${label} usage bridge timed out`)), timeoutMs);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      const detail = stderrBuffer.trim().slice(-300);
      finish(code === 0
        ? null
        : new Error(`${label} usage bridge exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrBuffer = `${stderrBuffer}${chunk}`.slice(-1000);
      });
    }
  });
}

function createBridgeRefresher(definition, options = {}) {
  const enabled = options.enabled === undefined ? definition.enabled : options.enabled;
  const refreshMs = options.refreshMs || definition.refreshMs;
  const warn = options.warn || ((message) => (
    console.warn(`[dashboard-server] ${definition.label || definition.id} usage bridge refresh failed:`, message)
  ));
  let attemptAt = 0;
  let promise = null;
  let lastWarning = null;

  return function refreshBridge(now = Date.now()) {
    const isEnabled = typeof enabled === 'function' ? enabled() : enabled;
    if (!isEnabled || promise || now - attemptAt < refreshMs) return false;
    attemptAt = now;
    promise = refreshBridgeSnapshot(definition, options)
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        if (message !== lastWarning) {
          warn(message);
          lastWarning = message;
        }
      })
      .finally(() => {
        promise = null;
      });
    return true;
  };
}

module.exports = {
  createBridgeRefresher,
  refreshBridgeSnapshot,
};
