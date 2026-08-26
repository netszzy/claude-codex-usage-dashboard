const { app, BrowserWindow, Menu, MenuItem, Tray, clipboard, dialog, ipcMain, nativeImage, screen, utilityProcess } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clampBoundsToArea, resizeBoundsFromBottomRight, resizeBoundsPreservingPosition } = require('./window-bounds');
const { buildTrayMenuTemplate } = require('./menu-template');
const { hasPhoneDisplayLaunchArgument, phoneDisplaySettings, phoneDisplayUrls } = require('../lib/phone-display');

app.setName('Usage Watch');

const PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT || 8787);
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('DASHBOARD_PORT must be an integer from 1 to 65535');
}
if (!LOCAL_HOSTS.has(HOST)) {
  throw new Error('DASHBOARD_HOST must be a loopback address');
}
let DATA_DIR = null;
let WINDOW_STATE_FILE = null;

const URL_HOST = HOST.includes(':') ? `[${HOST}]` : HOST;
const DASHBOARD_URL = `http://${URL_HOST}:${PORT}`;
const HEALTH_URL = `${DASHBOARD_URL}/healthz`;
const PHONE_DISPLAY = phoneDisplaySettings({
  env: hasPhoneDisplayLaunchArgument(process.argv)
    ? { ...process.env, PHONE_DISPLAY: 'on' }
    : process.env,
});
const PHONE_DISPLAY_URL = PHONE_DISPLAY.enabled
  ? `http://127.0.0.1:${PHONE_DISPLAY.port}/phone/`
  : null;
const ERROR_PAGE = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>Usage Dashboard unavailable</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; }
    body { display: grid; place-items: center; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0b0f16; color: #edf1fa; }
    .card { width: min(520px, calc(100% - 48px)); padding: 20px; border-radius: 16px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 20px 45px rgba(0,0,0,.45); }
    button { margin-top: 12px; border: 0; padding: 10px 14px; border-radius: 10px; color: #f2f4fc; background: #2d68ff; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="margin: 0 0 8px 0;">Usage dashboard is not responding</h2>
    <p style="margin: 0; color: #b5bed7; line-height: 1.5">
      本地服务未在规定时间启动，请稍后重试。可先点 Reload。
    </p>
    <div>
      <button onclick="window.desktopHud && window.desktopHud.retry()">Retry</button>
    </div>
  </div>
</body>
</html>
`;

let serverProcess = null;
let serverOwned = false;
let phoneDisplayProcess = null;
let mainWindow = null;
let isAlwaysOnTop = true;
let positionLocked = false;
let dragState = null;
let pendingHudSize = null;
let tray = null;
let isQuitting = false;
let lastServerError = '';
let phoneDisplayStatus = PHONE_DISPLAY.enabled ? 'starting' : 'off';
let phoneDisplayError = '';

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 224;
const MIN_HUD_WIDTH = 240;
const MAX_HUD_WIDTH = 32768;
const MIN_HUD_HEIGHT = 40;
const MAX_HUD_HEIGHT = 640;
const PHONE_DISPLAY_COMPANION_PORT = PHONE_DISPLAY.enabled
  ? (PORT === 8789 || PHONE_DISPLAY.port === 8789 ? 8790 : 8789)
  : null;

// Fractional display scaling can make window.getBounds() report a width/height
// that drifts from what was actually requested. Track the intended size ourselves
// instead of round-tripping through getBounds(), so that drift never compounds
// across repeated setBounds calls (e.g. during a drag).
let hudSize = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildErrorPageUrl() {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(ERROR_PAGE);
}

async function isDashboardReady() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(HEALTH_URL, { cache: 'no-store', signal: controller.signal });
    if (!res.ok || res.headers.get('x-usage-dashboard') !== '1') return false;
    const body = await res.json();
    return body && body.ok === true;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitDashboardReady(timeoutMs = 8000) {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    if (await isDashboardReady()) return true;
    await sleep(250);
  }
  return false;
}

function phoneDisplayErrorMessage(error) {
  const message = String(error || '');
  if (/EADDRINUSE/i.test(message)) return `端口 ${PHONE_DISPLAY.port} 已被其他程序占用。`;
  if (/EACCES/i.test(message)) return `没有权限使用端口 ${PHONE_DISPLAY.port}。`;
  return `手机服务未能在端口 ${PHONE_DISPLAY.port} 启动。请检查防火墙或重启看板。`;
}

function setPhoneDisplayStatus(status, error = '') {
  if (!PHONE_DISPLAY.enabled) return;
  phoneDisplayStatus = status;
  phoneDisplayError = error;
  rebuildTrayMenu();
}

async function isPhoneDisplayReady() {
  if (!PHONE_DISPLAY_URL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(PHONE_DISPLAY_URL, { cache: 'no-store', signal: controller.signal });
    return response.ok && response.headers.get('x-usage-phone-display') === '1';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensurePhoneDisplayReady(timeoutMs = 6000, retry = false) {
  if (!PHONE_DISPLAY.enabled) return true;
  const previousError = phoneDisplayError;
  if (retry || phoneDisplayStatus !== 'error') setPhoneDisplayStatus('starting');
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    if (await isPhoneDisplayReady()) {
      setPhoneDisplayStatus('ready');
      return true;
    }
    if (phoneDisplayStatus === 'error') return false;
    await sleep(250);
  }
  setPhoneDisplayStatus('error', phoneDisplayError || previousError || phoneDisplayErrorMessage());
  return false;
}

function ensureStateDir() {
  if (!DATA_DIR || !WINDOW_STATE_FILE) {
    DATA_DIR = app.getPath('userData');
    WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');
  }

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const legacyState = path.join(app.getPath('appData'), 'Electron', 'window-state.json');
    if (!fs.existsSync(WINDOW_STATE_FILE) && fs.existsSync(legacyState)) {
      fs.copyFileSync(legacyState, WINDOW_STATE_FILE, fs.constants.COPYFILE_EXCL);
    }
  } catch (error) {
    console.warn('[dashboard-desktop] cannot create state dir:', error.message);
  }
}

function loadWindowState() {
  try {
    if (!WINDOW_STATE_FILE || !fs.existsSync(WINDOW_STATE_FILE)) return null;
    const raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || typeof parsed.x !== 'number'
      || typeof parsed.y !== 'number'
      || typeof parsed.width !== 'number'
      || typeof parsed.height !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveWindowState(bounds) {
  if (!bounds) return;
  try {
    ensureStateDir();
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        alwaysOnTop: isAlwaysOnTop,
        positionLocked,
      }, null, 2),
      'utf8',
    );
  } catch (error) {
    console.warn('[dashboard-desktop] save window state failed:', error.message);
  }
}

function clampToScreen(bounds) {
  const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  return clampBoundsToArea(bounds, positionLocked ? display.bounds : display.workArea);
}

function keepWindowInWorkArea(window) {
  if (isQuitting || !window || window.isDestroyed()) return;
  const current = { ...window.getBounds(), width: hudSize.width, height: hudSize.height };
  const next = clampToScreen(current);
  if (
    current.x === next.x
    && current.y === next.y
    && current.width === next.width
    && current.height === next.height
  ) {
    return;
  }
  dragState = null;
  hudSize = { width: next.width, height: next.height };
  window.setBounds(next);
  saveWindowState(next);
}

function bindDisplayEvents() {
  const keepMainWindowInWorkArea = () => keepWindowInWorkArea(mainWindow);
  screen.on('display-metrics-changed', keepMainWindowInWorkArea);
  screen.on('display-removed', keepMainWindowInWorkArea);
  app.once('will-quit', () => {
    screen.off('display-metrics-changed', keepMainWindowInWorkArea);
    screen.off('display-removed', keepMainWindowInWorkArea);
  });
}

function buildInitialWindowBounds() {
  ensureStateDir();
  const saved = loadWindowState();
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = saved
    ? (() => {
      isAlwaysOnTop = saved.alwaysOnTop !== false;
      positionLocked = saved.positionLocked !== false;
      return clampToScreen({
        x: saved.x,
        y: saved.y,
        width: Math.min(Math.max(MIN_HUD_WIDTH, saved.width), MAX_HUD_WIDTH),
        height: Math.min(Math.max(MIN_HUD_HEIGHT, saved.height), MAX_HUD_HEIGHT),
      });
    })()
    : clampBoundsToArea({
      x: Math.floor(area.x + area.width - DEFAULT_WIDTH - 24),
      y: Math.floor(area.y + area.height - DEFAULT_HEIGHT - 24),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    }, area);
  hudSize = { width: bounds.width, height: bounds.height };
  if (saved && saved.positionLocked !== positionLocked) {
    saveWindowState(bounds);
  }
  return bounds;
}

async function detectServerRunning() {
  return isDashboardReady();
}

function spawnServer(environmentOverrides = {}, serviceName = 'Usage Watch local service') {
  const serverRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  const serverPath = path.join(serverRoot, 'server.js');
  const serverEnvironment = {
    ...process.env,
    PORT: String(PORT),
    HOST,
    NODE_NO_WARNINGS: '1',
    ...environmentOverrides,
  };
  if (!app.isPackaged) serverEnvironment.ELECTRON_RUN_AS_NODE = '1';
  const options = {
    cwd: serverRoot,
    env: serverEnvironment,
    stdio: ['ignore', 'ignore', 'pipe'],
  };
  const child = app.isPackaged
    ? utilityProcess.fork(serverPath, [], { ...options, serviceName })
    : spawn(process.execPath, [serverPath], options);

  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      lastServerError = String(chunk).trim().slice(-1000);
      if (lastServerError) console.error('[dashboard-desktop] server:', lastServerError);
      if (PHONE_DISPLAY.enabled && /\[phone-display-server\]/.test(lastServerError)) {
        setPhoneDisplayStatus('error', phoneDisplayErrorMessage(lastServerError));
      }
    });
  }

  child.on('error', (error) => {
    console.error('[dashboard-desktop] server spawn failed:', error.message);
  });

  child.on('exit', (code, signal) => {
    console.log('[dashboard-desktop] server exited:', code, signal);
    const wasPrimaryServer = serverProcess === child;
    const wasPhoneDisplayCompanion = phoneDisplayProcess === child;
    if (wasPrimaryServer) {
      serverProcess = null;
      serverOwned = false;
    } else if (wasPhoneDisplayCompanion) {
      phoneDisplayProcess = null;
    }
    if (PHONE_DISPLAY.enabled && !isQuitting && (wasPrimaryServer || wasPhoneDisplayCompanion)) {
      setPhoneDisplayStatus('error', phoneDisplayError || '手机服务已停止。请重新启动手机外接屏。');
    }
    if (wasPrimaryServer && mainWindow && mainWindow.webContents && mainWindow.webContents.isLoadingMainFrame()) {
      mainWindow.webContents.loadURL(buildErrorPageUrl());
    }
  });

  return child;
}

async function ensurePhoneDisplayServer() {
  if (!PHONE_DISPLAY.enabled || await isPhoneDisplayReady()) return;
  if (!phoneDisplayProcess) {
    console.log('[dashboard-desktop] starting phone display companion...');
    phoneDisplayProcess = spawnServer({
      PORT: String(PHONE_DISPLAY_COMPANION_PORT),
      PHONE_DISPLAY: 'on',
      PHONE_DISPLAY_HOST: PHONE_DISPLAY.host,
      PHONE_DISPLAY_PORT: String(PHONE_DISPLAY.port),
      PHONE_DISPLAY_SOURCE_PORT: String(PORT),
    }, 'Usage Watch phone display service');
  }
}

async function ensureServer() {
  if (await detectServerRunning()) {
    serverOwned = false;
    await ensurePhoneDisplayServer();
    await ensurePhoneDisplayReady();
    return true;
  }

  if (!serverProcess) {
    console.log('[dashboard-desktop] starting local server...');
    serverProcess = spawnServer();
    serverOwned = true;
  }

  const ok = await waitDashboardReady(12000);
  if (!ok) {
    console.error('[dashboard-desktop] server startup timeout');
    if (PHONE_DISPLAY.enabled) setPhoneDisplayStatus('error', '桌面服务未能启动，手机服务不可用。');
  } else {
    await ensurePhoneDisplayServer();
    await ensurePhoneDisplayReady();
  }
  return ok;
}

function bindWindowStatePersistence(window) {
  let timer = null;
  const persist = () => {
    if (window && !window.isDestroyed()) {
      const bounds = window.getBounds();
      saveWindowState(bounds);
    }
  };

  const schedulePersist = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 200);
  };

  window.on('moved', schedulePersist);
  window.on('resized', schedulePersist);
  window.on('close', persist);
}

function bindDragIpc() {
  ipcMain.on('hud-drag-begin', (event, point) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow || window.isDestroyed() || !point) return;
    const startX = Number(point.x);
    const startY = Number(point.y);
    if (!Number.isFinite(startX) || !Number.isFinite(startY)) return;
    const bounds = window.getBounds();
    dragState = {
      window,
      startX,
      startY,
      originX: bounds.x,
      originY: bounds.y,
    };
  });

  ipcMain.on('hud-drag-move', (event, point) => {
    if (!dragState || event.sender !== dragState.window.webContents || dragState.window.isDestroyed() || !point) return;
    const nextX = Number(point.x);
    const nextY = Number(point.y);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
    const requested = {
      x: Math.round(dragState.originX + nextX - dragState.startX),
      y: Math.round(dragState.originY + nextY - dragState.startY),
      width: hudSize.width,
      height: hudSize.height,
    };
    const display = screen.getDisplayNearestPoint({ x: requested.x, y: requested.y })
      || screen.getDisplayMatching(requested)
      || screen.getPrimaryDisplay();
    dragState.window.setBounds(clampBoundsToArea(requested, display.bounds));
  });

  ipcMain.on('hud-drag-end', (event) => {
    if (!dragState || event.sender !== dragState.window.webContents) return;
    if (dragState && dragState.window && !dragState.window.isDestroyed()) {
      const raw = dragState.window.getBounds();
      const bounds = { ...raw, width: hudSize.width, height: hudSize.height };
      positionLocked = true;
      saveWindowState(bounds);
      if (pendingHudSize) {
        const size = pendingHudSize;
        pendingHudSize = null;
        resizeHudWindow(dragState.window, size);
      }
    }
    dragState = null;
  });

  ipcMain.on('hud-resize', (event, size) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || mainWindow.isDestroyed() || !size) return;
    if (dragState) {
      pendingHudSize = size;
      return;
    }
    resizeHudWindow(mainWindow, size);
  });

  ipcMain.on('hud-retry', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || mainWindow.isDestroyed()) return;
    const ready = await ensureServer();
    const targetUrl = ready ? `${DASHBOARD_URL}/?mode=desktop` : buildErrorPageUrl();
    await mainWindow.loadURL(targetUrl).catch((error) => {
      lastServerError = error.message;
    });
  });
}

function resizeHudWindow(window, size) {
  if (!window || window.isDestroyed() || !size) return;
  const width = Math.round(Number(size.width));
  const height = Math.round(Number(size.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width < MIN_HUD_WIDTH || width > MAX_HUD_WIDTH || height < MIN_HUD_HEIGHT || height > MAX_HUD_HEIGHT) return;
  const current = { ...window.getBounds(), width: hudSize.width, height: hudSize.height };
  const display = screen.getDisplayMatching(current) || screen.getPrimaryDisplay();
  const area = positionLocked ? display.bounds : display.workArea;
  const bounds = positionLocked
    ? resizeBoundsPreservingPosition(current, { width, height }, area)
    : resizeBoundsFromBottomRight(current, { width, height }, area);
  if (
    current.x === bounds.x
    && current.y === bounds.y
    && current.width === bounds.width
    && current.height === bounds.height
  ) {
    return;
  }
  hudSize = { width: bounds.width, height: bounds.height };
  window.setBounds(bounds);
  saveWindowState(bounds);
}

function setTopMost(window) {
  isAlwaysOnTop = true;
  if (!window || window.isDestroyed()) return;
  window.setAlwaysOnTop(true, 'screen-saver');
}

function applyTopMost(window, value) {
  isAlwaysOnTop = Boolean(value);
  if (!window || window.isDestroyed()) return;
  window.setAlwaysOnTop(isAlwaysOnTop, 'screen-saver');
  rebuildTrayMenu();
}

function buildTrayIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.ico');
  const pngPath = path.join(__dirname, '..', 'assets', 'tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) return icon;

  const png = nativeImage.createFromPath(pngPath);
  if (!png.isEmpty()) return png;

  return nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAfElEQVR4Ae3XsQmAMAwF0S6RKuQ+KXsHOVskuydCuohkqWQO0iUgQf5+9xL8z/g0G87JuVdiKcslJpzw7XBlxKnAoIGneZNBpzgkKNAeMwpYHI5o0HwJVAhX0EFrAaBmhGuFmJqew7UCim8V4a86JoJ0bENQq4GkqN+Vq7wAi7E+gUJpB8oAAAAASUVORK5CYII=');
}

function showWindow() {
  revealWindow(mainWindow);
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  saveWindowState(mainWindow.getBounds());
  mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function phoneDisplayDetail() {
  const urls = PHONE_DISPLAY.host === '127.0.0.1'
    ? [`http://127.0.0.1:${PHONE_DISPLAY.port}/phone/`]
    : phoneDisplayUrls(PHONE_DISPLAY.port);
  const addressList = urls.length
    ? urls.map((url) => `• ${url}`).join('\n')
    : `• http://<本机局域网 IP>:${PHONE_DISPLAY.port}/phone/`;
  return {
    urls,
    text: [
      phoneDisplayStatus === 'ready'
        ? '本机手机服务已就绪。'
        : `当前状态：${phoneDisplayError || '正在检查手机服务。'}`,
      '',
      '手机和电脑连接同一 Wi-Fi 后，在 Safari 打开以下任一地址：',
      addressList,
      '',
      `配对码：${PHONE_DISPLAY.access.pairingCode}`,
      '',
      '首次配对成功后，可在 iPhone Safari 的分享菜单中“添加到主屏幕”。',
      '如果这台电脑有多个虚拟网卡，请选择与手机同网段的地址。',
    ].join('\n'),
  };
}

async function showPhoneDisplayInfo() {
  if (!PHONE_DISPLAY.enabled) return;
  const info = phoneDisplayDetail();
  const result = await dialog.showMessageBox({
    type: phoneDisplayStatus === 'error' ? 'error' : 'info',
    title: '手机外接屏',
    message: phoneDisplayStatus === 'ready' ? '手机外接屏已就绪' : '手机外接屏尚未就绪',
    detail: info.text,
    buttons: phoneDisplayStatus === 'ready' ? ['复制连接信息', '关闭'] : ['重新检测', '关闭'],
    defaultId: 1,
  });
  if (phoneDisplayStatus === 'ready' && result.response === 0 && info.urls[0]) {
    clipboard.writeText(`${info.urls[0]}\n配对码：${PHONE_DISPLAY.access.pairingCode}`);
  }
  if (phoneDisplayStatus !== 'ready' && result.response === 0) {
    await ensurePhoneDisplayReady(6000, true);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(
    {
      visible: Boolean(mainWindow && mainWindow.isVisible()),
      alwaysOnTop: isAlwaysOnTop,
      phoneDisplay: PHONE_DISPLAY.enabled,
      phoneDisplayStatus,
    },
    {
      toggle: toggleWindow,
      reload: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
          showWindow();
        }
      },
      setAlwaysOnTop: (menuItem) => applyTopMost(mainWindow, menuItem.checked),
      showPhoneDisplay: showPhoneDisplayInfo,
      quit: () => app.quit(),
    },
  )));
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('Usage Watch - Claude / Codex');
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
  rebuildTrayMenu();
}

function attachContextMenu(window) {
  const menu = Menu.buildFromTemplate([
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: isAlwaysOnTop,
      click: (menuItem) => applyTopMost(window, menuItem.checked),
    },
    { type: 'separator' },
    {
      label: '重载',
      accelerator: 'CmdOrCtrl+R',
      click: () => window && !window.isDestroyed() && window.reload(),
    },
    {
      label: '打开开发者工具',
      accelerator: 'F12',
      click: () => {
        if (!window || window.isDestroyed()) return;
        if (window.webContents.isDevToolsOpened()) {
          window.webContents.closeDevTools();
        } else {
          window.webContents.openDevTools({ mode: 'detach' });
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      accelerator: 'Alt+F4',
      click: () => app.quit(),
    },
  ]);

  window.webContents.on('context-menu', (event) => {
    menu.popup({ window });
    event.preventDefault();
  });
}

function makeSimpleMenu() {
  const menu = new Menu();
  menu.append(new MenuItem({
    label: 'File',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'F5',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.reload();
          }
        },
      },
      {
        label: 'Toggle DevTools',
        accelerator: 'F12',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.webContents.isDevToolsOpened()) {
              mainWindow.webContents.closeDevTools();
            } else {
              mainWindow.webContents.openDevTools({ mode: 'detach' });
            }
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Exit',
        click: () => app.quit(),
      },
    ],
  }));
  Menu.setApplicationMenu(menu);
}

function revealWindow(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) {
    window.restore();
  }
  keepWindowInWorkArea(window);
  window.setSkipTaskbar(true);
  if (isAlwaysOnTop) {
    window.setAlwaysOnTop(true, 'screen-saver');
  }
  window.show();
  window.moveTop();
  window.focus();
  rebuildTrayMenu();
}

async function createWindow() {
  const ready = await ensureServer();
  const bounds = buildInitialWindowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Claude / Codex Usage Dashboard',
  });
  mainWindow.setOpacity(1);

  applyTopMost(mainWindow, isAlwaysOnTop);
  makeSimpleMenu();
  attachContextMenu(mainWindow);
  bindWindowStatePersistence(mainWindow);

  const dashboardOrigin = new URL(DASHBOARD_URL).origin;
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin !== dashboardOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const targetUrl = ready
    ? `${DASHBOARD_URL}?mode=desktop`
    : buildErrorPageUrl();
  mainWindow.loadURL(targetUrl).catch((error) => {
    console.error('[dashboard-desktop] failed to open dashboard URL:', error.message);
  });
  mainWindow.once('ready-to-show', () => {
    revealWindow(mainWindow);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    revealWindow(mainWindow);
  });

  mainWindow.on('focus', () => {
    if (isAlwaysOnTop) {
      setTopMost(mainWindow);
    }
  });

  mainWindow.on('hide', rebuildTrayMenu);
  mainWindow.on('show', rebuildTrayMenu);
  mainWindow.on('minimize', rebuildTrayMenu);
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    rebuildTrayMenu();
  });
}

function stopServer() {
  if (serverProcess && serverOwned && !serverProcess.killed) {
    try {
      serverProcess.kill();
    } catch (error) {
      console.warn('[dashboard-desktop] stop server failed:', error.message);
    }
    serverProcess = null;
  }
  if (phoneDisplayProcess && !phoneDisplayProcess.killed) {
    try {
      phoneDisplayProcess.kill();
    } catch (error) {
      console.warn('[dashboard-desktop] stop phone display service failed:', error.message);
    }
    phoneDisplayProcess = null;
  }
}

function relaunchWithPhoneDisplay() {
  if (PHONE_DISPLAY.enabled) {
    showWindow();
    return;
  }
  process.env.PHONE_DISPLAY = 'on';
  isQuitting = true;
  const relaunchArgs = process.argv.slice(1);
  if (!hasPhoneDisplayLaunchArgument(relaunchArgs)) relaunchArgs.push('--phone-display');
  app.relaunch({ args: relaunchArgs });
  app.quit();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (hasPhoneDisplayLaunchArgument(commandLine)) {
      relaunchWithPhoneDisplay();
      return;
    }
    showWindow();
  });

  app.whenReady().then(async () => {
    try {
      bindDragIpc();
      bindDisplayEvents();
      ensureTray();
      await createWindow();
    } catch (error) {
      lastServerError = error.message;
      console.error('[dashboard-desktop] startup failed:', error.message);
      if (mainWindow) {
        mainWindow.loadURL(buildErrorPageUrl()).catch(() => {});
        mainWindow.show();
      } else {
        app.quit();
      }
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopServer();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && isQuitting) {
      app.quit();
    }
  });
}
