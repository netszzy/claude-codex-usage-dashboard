'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

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

module.exports = {
  DASHBOARD_CSS,
  DASHBOARD_HTML,
  DASHBOARD_JS,
  LOCAL_HOSTS,
  SECURITY_HEADERS,
  createDashboardServer,
  etagFor,
  originIsLocal,
  pageHtml,
  readJsonRequest,
  requestHostName,
  writeResponse,
};
