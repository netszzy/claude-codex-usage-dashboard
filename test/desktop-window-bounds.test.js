'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { clampBoundsToArea, resizeBoundsFromBottomRight } = require('../desktop/window-bounds');

test('oversized HUD bounds are reduced to the display work area', () => {
  assert.deepEqual(
    clampBoundsToArea(
      { x: 100, y: 20, width: 600, height: 640 },
      { x: 0, y: 0, width: 480, height: 500 },
    ),
    { x: 0, y: 0, width: 480, height: 500 },
  );
});

test('bounds remain visible on negative-coordinate and ordinary displays', () => {
  assert.deepEqual(
    clampBoundsToArea(
      { x: -2100, y: 900, width: 380, height: 224 },
      { x: -1920, y: 0, width: 1920, height: 1040 },
    ),
    { x: -1920, y: 816, width: 380, height: 224 },
  );
  assert.deepEqual(
    clampBoundsToArea(
      { x: 1516, y: 792, width: 380, height: 224 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ),
    { x: 1516, y: 792, width: 380, height: 224 },
  );
});

test('HUD resize keeps its bottom-right anchor and restores it after a round trip', () => {
  const current = { x: 1516, y: 792, width: 380, height: 224 };
  const resized = resizeBoundsFromBottomRight(
    current,
    { width: 500, height: 420 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  assert.deepEqual(resized, { x: 1396, y: 596, width: 500, height: 420 });
  assert.equal(resized.x + resized.width, current.x + current.width);
  assert.equal(resized.y + resized.height, current.y + current.height);

  const restored = resizeBoundsFromBottomRight(
    resized,
    { width: current.width, height: current.height },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  assert.deepEqual(restored, current);
});

test('wide strip resize fills the available display width at its compact height', () => {
  const current = { x: 1516, y: 792, width: 380, height: 224 };
  const resized = resizeBoundsFromBottomRight(
    current,
    { width: 32768, height: 48 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );

  assert.deepEqual(resized, { x: 0, y: 968, width: 1920, height: 48 });
  assert.equal(resized.y + resized.height, current.y + current.height);

  const mini = resizeBoundsFromBottomRight(
    current,
    { width: 32768, height: 40 },
    { x: 0, y: 0, width: 1920, height: 1040 },
  );
  assert.deepEqual(mini, { x: 0, y: 976, width: 1920, height: 40 });
  assert.equal(mini.y + mini.height, current.y + current.height);
});

test('desktop shell re-clamps the current window when display geometry changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  assert.match(source, /const display = screen\.getDisplayMatching\(current\) \|\| screen\.getPrimaryDisplay\(\)/);
  assert.match(source, /resizeBoundsFromBottomRight\(current, \{ width, height \}, display\.workArea\)/);
  assert.match(source, /screen\.on\('display-metrics-changed', keepMainWindowInWorkArea\)/);
  assert.match(source, /screen\.on\('display-removed', keepMainWindowInWorkArea\)/);
  assert.match(source, /screen\.off\('display-metrics-changed', keepMainWindowInWorkArea\)/);
  assert.match(source, /app\.whenReady\(\)\.then\([\s\S]*bindDisplayEvents\(\)/);
  assert.match(source, /function revealWindow\(window\) \{[\s\S]*keepWindowInWorkArea\(window\)/);
  assert.match(source, /backgroundThrottling:\s*true/);
});

test('desktop resize accepts full-width strip requests while retaining safe limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

  assert.match(source, /const MAX_HUD_WIDTH = 32768;/);
  assert.match(source, /const MIN_HUD_HEIGHT = 40;/);
  assert.match(source, /width < MIN_HUD_WIDTH \|\| width > MAX_HUD_WIDTH/);
  assert.match(source, /height < MIN_HUD_HEIGHT \|\| height > MAX_HUD_HEIGHT/);
});
