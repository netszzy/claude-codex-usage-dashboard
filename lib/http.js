'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { isPrivatePeerAddress, isValidAccess, parseCookies, secureEquals } = require('./phone-display');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Usage-Dashboard': '1',
});

const ROOT = path.join(__dirname, '..');
const DASHBOARD_HTML = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const DASHBOARD_CSS = fs.readFileSync(path.join(ROOT, 'dashboard.css'), 'utf8');
const DASHBOARD_JS = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const PHONE_DISPLAY_HTML = fs.readFileSync(path.join(ROOT, 'phone-display.html'), 'utf8');
const PHONE_DISPLAY_CSS = fs.readFileSync(path.join(ROOT, 'phone-display.css'), 'utf8');
const PHONE_DISPLAY_JS = fs.readFileSync(path.join(ROOT, 'phone-display.js'), 'utf8');
const PHONE_PAIR_CSS = fs.readFileSync(path.join(ROOT, 'phone-pair.css'), 'utf8');
const PHONE_COOKIE = 'usage_watch_phone';
const PHONE_PAIR_CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function pageHtml() {
  return DASHBOARD_HTML;
}

function requestHostName(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : '';
  }
  return value.split(':')[0];
}

function originIsLocal(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return url.protocol === 'http:' && LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

function writeResponse(request, response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...extraHeaders,
  });
  response.end(request.method === 'HEAD' || status === 304 ? undefined : body);
}

function writePhoneResponse(request, response, status, contentType, body, extraHeaders = {}) {
  writeResponse(request, response, status, contentType, body, {
    ...extraHeaders,
    'X-Usage-Phone-Display': '1',
  });
}

function etagFor(body) {
  return `"${crypto.createHash('sha256').update(body).digest('base64url')}"`;
}

function readJsonRequest(request, maximumBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (oversized) {
        const error = new Error('请求体过大');
        error.statusCode = 413;
        reject(error);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch {
        const error = new Error('请求体必须是有效 JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
  });
}

function readFormRequest(request, maximumBytes = 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (oversized) {
        const error = new Error('请求体过大');
        error.statusCode = 413;
        reject(error);
        return;
      }
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function phonePairingHtml(error = '') {
  const message = error ? '<p class="error" role="alert">配对码不正确，请检查桌面托盘中的“手机外接屏”。</p>' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111114">
  <title>连接 Usage Watch</title>
  <link rel="stylesheet" href="./phone-pair.css">
</head>
<body>
  <main>
    <h1>连接 Usage Watch</h1>
    <p>在电脑托盘菜单中打开“手机外接屏”，输入显示的 12 位配对码。配对成功后，这台手机会保持只读访问。</p>
    ${message}
    <form method="post" action="./pair">
      <label for="pairing_code">配对码</label>
      <input id="pairing_code" name="code" autocomplete="one-time-code" autocapitalize="characters" maxlength="14" placeholder="ABCD-EFGH-JKLM" required>
      <button type="submit">连接显示屏</button>
    </form>
  </main>
</body>
</html>`;
}

function phoneSessionIsValid(request, access) {
  return secureEquals(parseCookies(request.headers.cookie)[PHONE_COOKIE], access.token);
}

function phoneCookie(access) {
  return `${PHONE_COOKIE}=${access.token}; Path=/phone; Max-Age=31536000; HttpOnly; SameSite=Strict`;
}

function createPairingRateLimiter() {
  const attempts = new Map();
  const windowMs = 10 * 60 * 1000;
  const maximumAttempts = 5;
  return {
    recordFailure(address, now = Date.now()) {
      const previous = attempts.get(address);
      const entry = !previous || previous.expiresAt <= now
        ? { count: 0, expiresAt: now + windowMs }
        : previous;
      entry.count += 1;
      attempts.set(address, entry);
      return entry.count >= maximumAttempts;
    },
    isBlocked(address, now = Date.now()) {
      const entry = attempts.get(address);
      if (!entry) return false;
      if (entry.expiresAt <= now) {
        attempts.delete(address);
        return false;
      }
      return entry.count >= maximumAttempts;
    },
    clear(address) {
      attempts.delete(address);
    },
  };
}

function createDashboardServer(options = {}) {
  const usageProvider = options.usageProvider;
  const configStore = options.configStore;
  if (typeof usageProvider !== 'function') throw new Error('usageProvider is required');
  return http.createServer(async (request, response) => {
    try {
      const hostName = requestHostName(request.headers.host);
      if (!LOCAL_HOSTS.has(hostName)) {
        writeResponse(request, response, 403, 'text/plain; charset=utf-8', 'Forbidden host');
        return;
      }
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'POST' && requestUrl.pathname === '/api/config') {
        if (!configStore || typeof configStore.update !== 'function') {
          writeResponse(request, response, 404, 'text/plain; charset=utf-8', 'Not found');
          return;
        }
        if (!originIsLocal(request.headers.origin)) {
          writeResponse(request, response, 403, 'text/plain; charset=utf-8', 'Forbidden origin');
          return;
        }
        let config;
        try {
          config = configStore.update(await readJsonRequest(request));
        } catch (error) {
          if (!error.statusCode) error.statusCode = 400;
          throw error;
        }
        writeResponse(
          request,
          response,
          200,
          'application/json; charset=utf-8',
          JSON.stringify({ config }),
        );
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeResponse(
          request,
          response,
          405,
          'text/plain; charset=utf-8',
          'Method not allowed',
          { Allow: 'GET, HEAD, POST' },
        );
        return;
      }
      if (requestUrl.pathname === '/healthz') {
        writeResponse(request, response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        return;
      }
      if (requestUrl.pathname === '/api/usage') {
        const body = JSON.stringify(await usageProvider());
        const etag = etagFor(body);
        if (request.headers['if-none-match'] === etag) {
          writeResponse(request, response, 304, null, null, { ETag: etag });
          return;
        }
        writeResponse(request, response, 200, 'application/json; charset=utf-8', body, { ETag: etag });
        return;
      }
      if (requestUrl.pathname === '/dashboard.css') {
        writeResponse(request, response, 200, 'text/css; charset=utf-8', DASHBOARD_CSS);
        return;
      }
      if (requestUrl.pathname === '/dashboard.js') {
        writeResponse(request, response, 200, 'text/javascript; charset=utf-8', DASHBOARD_JS);
        return;
      }
      if (requestUrl.pathname === '/' && requestUrl.searchParams.get('mode') === 'desktop') {
        writeResponse(request, response, 200, 'text/html; charset=utf-8', pageHtml());
        return;
      }
      writeResponse(
        request,
        response,
        404,
        'text/plain; charset=utf-8',
        requestUrl.pathname === '/'
          ? 'Web mode has been removed. Start the desktop floating dashboard with start-dashboard-desktop.bat or npm start.'
          : 'Not found',
      );
    } catch (error) {
      const status = error && error.statusCode === 413 ? 413 : error && error.statusCode === 400 ? 400 : 500;
      if (status >= 500) console.error('[dashboard-server] request failed:', error.message);
      if (!response.headersSent) {
        writeResponse(
          request,
          response,
          status,
          'text/plain; charset=utf-8',
          status === 400 ? error.message : status === 413 ? 'Payload too large' : 'Internal server error',
        );
      } else {
        response.destroy();
      }
    }
  });
}

function createPhoneDisplayServer(options = {}) {
  const usageProvider = options.usageProvider;
  const access = options.access;
  if (typeof usageProvider !== 'function') throw new Error('usageProvider is required');
  if (!isValidAccess(access)) {
    throw new Error('phone display access is required');
  }
  const pairingAttempts = options.pairingAttempts || createPairingRateLimiter();

  return http.createServer(async (request, response) => {
    try {
      const remoteAddress = request.socket && request.socket.remoteAddress;
      if (!isPrivatePeerAddress(remoteAddress)) {
        writePhoneResponse(request, response, 403, 'text/plain; charset=utf-8', 'Private network only');
        return;
      }

      const requestUrl = new URL(request.url || '/', 'http://phone-display.local');
      const requestPath = requestUrl.pathname;
      if (requestPath === '/phone') {
        writePhoneResponse(request, response, 302, 'text/plain; charset=utf-8', 'Found', { Location: '/phone/' });
        return;
      }
      if (!requestPath.startsWith('/phone/')) {
        writePhoneResponse(request, response, 404, 'text/plain; charset=utf-8', 'Not found');
        return;
      }

      if (request.method === 'POST' && requestPath === '/phone/pair') {
        if (pairingAttempts.isBlocked(remoteAddress)) {
          writePhoneResponse(request, response, 429, 'text/plain; charset=utf-8', 'Too many pairing attempts', { 'Retry-After': '600' });
          return;
        }
        const form = await readFormRequest(request);
        const submittedCode = String(form.get('code') || '').trim().toUpperCase();
        if (!secureEquals(submittedCode, access.pairingCode)) {
          pairingAttempts.recordFailure(remoteAddress);
          writePhoneResponse(request, response, 401, 'text/html; charset=utf-8', phonePairingHtml('invalid'), {
            'Content-Security-Policy': PHONE_PAIR_CSP,
          });
          return;
        }
        pairingAttempts.clear(remoteAddress);
        writePhoneResponse(request, response, 303, 'text/plain; charset=utf-8', 'See other', {
          Location: '/phone/',
          'Set-Cookie': phoneCookie(access),
        });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writePhoneResponse(request, response, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD, POST' });
        return;
      }

      if (requestPath === '/phone/') {
        if (!phoneSessionIsValid(request, access)) {
          writePhoneResponse(request, response, 200, 'text/html; charset=utf-8', phonePairingHtml(), {
            'Content-Security-Policy': PHONE_PAIR_CSP,
          });
          return;
        }
        writePhoneResponse(request, response, 200, 'text/html; charset=utf-8', PHONE_DISPLAY_HTML);
        return;
      }

      if (requestPath === '/phone/phone-pair.css') {
        writePhoneResponse(request, response, 200, 'text/css; charset=utf-8', PHONE_PAIR_CSS);
        return;
      }

      if (!phoneSessionIsValid(request, access)) {
        writePhoneResponse(request, response, 403, 'text/plain; charset=utf-8', 'Pairing required');
        return;
      }
      if (requestPath === '/phone/phone-display.css') {
        writePhoneResponse(request, response, 200, 'text/css; charset=utf-8', PHONE_DISPLAY_CSS);
        return;
      }
      if (requestPath === '/phone/phone-display.js') {
        writePhoneResponse(request, response, 200, 'text/javascript; charset=utf-8', PHONE_DISPLAY_JS);
        return;
      }
      if (requestPath === '/phone/api/usage') {
        const body = JSON.stringify(await usageProvider());
        const etag = etagFor(body);
        if (request.headers['if-none-match'] === etag) {
          writePhoneResponse(request, response, 304, null, null, { ETag: etag });
          return;
        }
        writePhoneResponse(request, response, 200, 'application/json; charset=utf-8', body, { ETag: etag });
        return;
      }
      writePhoneResponse(request, response, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      const status = error && error.statusCode === 413 ? 413 : 500;
      if (status >= 500) console.error('[phone-display-server] request failed:', error.message);
      if (!response.headersSent) {
        writePhoneResponse(request, response, status, 'text/plain; charset=utf-8', status === 413 ? 'Payload too large' : 'Internal server error');
      } else {
        response.destroy();
      }
    }
  });
}

module.exports = {
  DASHBOARD_CSS,
  DASHBOARD_HTML,
  DASHBOARD_JS,
  PHONE_DISPLAY_CSS,
  PHONE_DISPLAY_HTML,
  PHONE_DISPLAY_JS,
  PHONE_PAIR_CSS,
  PHONE_PAIR_CSP,
  LOCAL_HOSTS,
  SECURITY_HEADERS,
  createDashboardServer,
  createPhoneDisplayServer,
  createPairingRateLimiter,
  etagFor,
  originIsLocal,
  pageHtml,
  readJsonRequest,
  readFormRequest,
  requestHostName,
  writeResponse,
  writePhoneResponse,
};
