const http = require('node:http');
const { DEMO_DIR, DEMO_FILES, serveAsset } = require('./frontend-assets');
const { setSecurityHeaders } = require('./deployment-security');

function localServiceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('LOCAL_AGENT_URL_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('LOCAL_AGENT_URL_INVALID');
  }
  return url;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function proxyApi(req, res, route, target) {
  // Administration is a separate service, never a public frontend proxy target.
  if (/^\/api\/admin(?:\/|$)/u.test(route)) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  const headers = { ...req.headers };
  // Keep the browser origin and Host paired so backend CSRF checks still apply.
  // Strip hop-by-hop and management credentials instead of relaxing CORS.
  for (const name of ['connection', 'proxy-authorization', 'proxy-connection', 'upgrade', 'transfer-encoding']) delete headers[name];
  headers.cookie = String(req.headers.cookie || '').split(';').map(p => p.trim()).filter(p => p.startsWith('va_owner=')).join('; ');
  const upstream = http.request(target, { method: req.method, path: req.url, headers, timeout: 25000 }, incoming => {
    const responseHeaders = { ...incoming.headers };
    delete responseHeaders.connection;
    res.writeHead(incoming.statusCode, responseHeaders);
    incoming.pipe(res);
    incoming.on('error', () => res.destroy());
  });
  const failed = () => {
    req.resume();
    if (!res.headersSent && !res.destroyed) json(res, 502, { ok: false, error: 'AGENT_BACKEND_UNAVAILABLE', message: '实验服务暂不可用，请检查语音后台启动窗口。' });
    else if (!res.destroyed) res.destroy();
  };
  upstream.on('error', failed);
  upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

function createFrontendServer({ backendUrl = 'http://127.0.0.1:8100/' } = {}) {
  const target = localServiceUrl(backendUrl);
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res, { production: false });
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && route === '/frontend-health') return json(res, 200, { ok: true, service: 'voice-agent-demo-frontend' });
      if (await serveAsset(req, res, route, DEMO_DIR, DEMO_FILES)) return;
      if (route.startsWith('/api/')) return proxyApi(req, res, route, target);
      json(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch { if (!res.headersSent) json(res, 500, { ok: false, error: 'FRONTEND_REQUEST_FAILED' }); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  return { server, backendUrl: target.origin };
}

module.exports = { createFrontendServer, localServiceUrl, json };
