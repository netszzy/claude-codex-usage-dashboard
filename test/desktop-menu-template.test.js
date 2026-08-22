'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTrayMenuTemplate } = require('../desktop/menu-template');

test('tray menu template reflects window state and keeps action handlers', () => {
  const actions = {
    toggle() {},
    reload() {},
    setAlwaysOnTop() {},
    quit() {},
  };

  const visible = buildTrayMenuTemplate({ visible: true, alwaysOnTop: true }, actions);
  assert.equal(visible[0].label, '隐藏浮窗');
  assert.equal(visible[2].checked, true);
  assert.equal(visible[0].click, actions.toggle);
  assert.equal(visible[1].click, actions.reload);
  assert.equal(visible[2].click, actions.setAlwaysOnTop);
  assert.equal(visible[4].click, actions.quit);

  const hidden = buildTrayMenuTemplate({ visible: false, alwaysOnTop: false }, actions);
  assert.equal(hidden[0].label, '显示浮窗');
  assert.equal(hidden[2].checked, false);
});
