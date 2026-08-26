'use strict';

function buildTrayMenuTemplate(state, actions) {
  const phoneDisplayLabel = state.phoneDisplayStatus === 'ready'
    ? '手机外接屏（已就绪）…'
    : state.phoneDisplayStatus === 'error'
      ? '手机外接屏（不可用）…'
      : '手机外接屏（启动中）…';
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
    ...(state.phoneDisplay ? [{
      label: phoneDisplayLabel,
      click: actions.showPhoneDisplay,
    }] : []),
    { type: 'separator' },
    {
      label: '退出',
      click: actions.quit,
    },
  ];
}

module.exports = { buildTrayMenuTemplate };
