const fs = require('node:fs');
const path = require('node:path');

const DEMO_DIR = path.join(__dirname, '../public');
const DEMO_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/audio-tools.js', ['audio-tools.js', 'text/javascript; charset=utf-8']],
  ['/voice-network.js', ['voice-network.js', 'text/javascript; charset=utf-8']],
]);

async function serveAsset(req, res, route, directory, files) {
  if (req.method !== 'GET' || !files.has(route)) return false;
  const [filename, type] = files.get(route);
  const data = await fs.promises.readFile(path.join(directory, filename));
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
  return true;
}

module.exports = { DEMO_DIR, DEMO_FILES, serveAsset };
