'use strict';

function buildTrayMenuTemplate(state, actions) {
  return [
    {
      label: state.visible ? '隐藏浮窗' : '显示浮窗',
      click: actions.toggle,
    },
    {
      label: '重载',
      click: actions.reload,
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: state.alwaysOnTop,
      click: actions.setAlwaysOnTop,
    },
    { type: 'separator' },
    {
      label: '退出',
      click: actions.quit,
    },
  ];
}

module.exports = { buildTrayMenuTemplate };
