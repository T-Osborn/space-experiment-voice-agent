const { createAdminServer } = require('./admin-server');
const { AdminService } = require('./admin-service');
const port = Number(process.env.ADMIN_PORT || 8110);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ADMIN_PORT_INVALID');
const { server } = createAdminServer({ service: new AdminService({
  backendUrl: process.env.VOICE_AGENT_URL || 'http://127.0.0.1:8100/',
  demoUrl: process.env.DEMO_FRONTEND_URL || 'http://127.0.0.1:8120/',
}) });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'ADMIN_PORT_IN_USE' : 'ADMIN_START_FAILED'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('Management console: http://127.0.0.1:' + port + '/'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
