'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { clampBoundsToArea, resizeBoundsFromBottomRight, resizeBoundsPreservingPosition } = require('../desktop/window-bounds');

test('HUD keeps polling when Windows de-prioritizes a floating window', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  assert.match(mainSource, /backgroundThrottling:\s*false/);
});

test('phone mode starts a companion that mirrors the desktop API', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  assert.match(mainSource, /async function ensurePhoneDisplayServer\(\)/);
  assert.match(mainSource, /PHONE_DISPLAY_SOURCE_PORT:\s*String\(PORT\)/);
  assert.match(mainSource, /await ensurePhoneDisplayServer\(\);/);
});

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

test('a dragged HUD keeps its position when refreshed content requests a new size', () => {
  const current = { x: 1338, y: 920, width: 960, height: 40 };
  const resized = resizeBoundsPreservingPosition(
    current,
    { width: 1200, height: 56 },
    { x: 0, y: 0, width: 2560, height: 1040 },
  );
  assert.deepEqual(resized, { x: 1338, y: 920, width: 1200, height: 56 });

  const constrained = resizeBoundsPreservingPosition(
    current,
    { width: 1600, height: 200 },
    { x: 0, y: 0, width: 2560, height: 1040 },
  );
  assert.deepEqual(constrained, { x: 1338, y: 920, width: 1222, height: 120 });
});

test('a dragged HUD may overlap the Windows taskbar and remains on the display', () => {
  const display = {
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  };
  const overlapping = { x: 1338, y: 1404, width: 960, height: 32 };
  assert.deepEqual(clampBoundsToArea(overlapping, display.bounds), overlapping);
  assert.notDeepEqual(clampBoundsToArea(overlapping, display.workArea), overlapping);
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
  assert.match(source, /return clampBoundsToArea\(bounds, positionLocked \? display\.bounds : display\.workArea\)/);
  assert.match(source, /const area = positionLocked \? display\.bounds : display\.workArea/);
  assert.match(source, /resizeBoundsPreservingPosition\(current, \{ width, height \}, area\)/);
  assert.match(source, /width: Math\.min\(Math\.max\(MIN_HUD_WIDTH, saved\.width\), MAX_HUD_WIDTH\)/);
  assert.match(source, /positionLocked = true;/);
  assert.match(source, /saved\.positionLocked !== positionLocked/);
  assert.match(source, /screen\.on\('display-metrics-changed', keepMainWindowInWorkArea\)/);
  assert.match(source, /screen\.on\('display-removed', keepMainWindowInWorkArea\)/);
  assert.match(source, /screen\.off\('display-metrics-changed', keepMainWindowInWorkArea\)/);
  assert.match(source, /app\.whenReady\(\)\.then\([\s\S]*bindDisplayEvents\(\)/);
  assert.match(source, /function revealWindow\(window\) \{[\s\S]*keepWindowInWorkArea\(window\)/);
  assert.match(source, /backgroundThrottling:\s*false/);
});

test('desktop resize accepts full-width strip requests while retaining safe limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

  assert.match(source, /const MAX_HUD_WIDTH = 32768;/);
  assert.match(source, /const MIN_HUD_HEIGHT = 40;/);
  assert.match(source, /width < MIN_HUD_WIDTH \|\| width > MAX_HUD_WIDTH/);
  assert.match(source, /height < MIN_HUD_HEIGHT \|\| height > MAX_HUD_HEIGHT/);
});
