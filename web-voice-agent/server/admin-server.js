const http = require('node:http');
const path = require('node:path');
const { DemoAccess, deploymentConfig, assertSameOrigin, setSecurityHeaders } = require('./deployment-security');
const { serveAsset } = require('./frontend-assets');
const { json } = require('./frontend-server');
const { AdminService } = require('./admin-service');

const ADMIN_DIR = path.join(__dirname, '../admin');
const ADMIN_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
]);

function createAdminServer({ service = new AdminService(), access } = {}) {
  // A local management surface, not a second public entry to the demo API.
  const config = deploymentConfig({ HOST: '127.0.0.1' });
  access ||= new DemoAccess(config, { cookieName: 'va_admin', maxOwners: 32 });
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res, config);
    try {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (await serveAsset(req, res, route, ADMIN_DIR, ADMIN_FILES)) return;
      if (req.method === 'GET' && route === '/api/health') return json(res, 200, { ok: true, service: 'voice-agent-management' });
      if (!route.startsWith('/api/admin/')) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
      if (req.method === 'POST' && route === '/api/admin/access') {
        assertSameOrigin(req, config);
        // No credentials or configuration are accepted by this first-stage endpoint.
        if (Number(req.headers['content-length'] || 0) > 256 || req.headers['transfer-encoding']) {
          req.resume(); return json(res, 413, { ok: false, error: 'REQUEST_TOO_LARGE' });
        }
        req.resume(); access.grant(req, res, '');
        return json(res, 200, { ok: true, role: 'LOCAL_MANAGEMENT', read_only: true });
      }
      const owner = access.owner(req); access.checkRate(owner);
      if (req.method !== 'GET') { req.resume(); return json(res, 405, { ok: false, error: 'ADMIN_READ_ONLY' }); }
      if (route === '/api/admin/overview') return json(res, 200, await service.overview());
      const match = /^\/api\/admin\/modules\/([a-z]+)$/u.exec(route);
      const detail = match && service.detail(match[1]);
      if (detail) return json(res, 200, detail);
      json(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (error) {
      req.resume();
      if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.status ? error.message : 'ADMIN_REQUEST_FAILED' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  return { server, service };
}

module.exports = { createAdminServer };
