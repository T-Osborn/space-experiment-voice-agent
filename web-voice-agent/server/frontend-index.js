const { createFrontendServer } = require('./frontend-server');
const port = Number(process.env.DEMO_PORT || 8120);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DEMO_PORT_INVALID');
const { server } = createFrontendServer({ backendUrl: process.env.VOICE_AGENT_URL || 'http://127.0.0.1:8100/' });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'DEMO_PORT_IN_USE' : 'DEMO_START_FAILED'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('Demo frontend: http://127.0.0.1:' + port + '/'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
