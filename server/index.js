// Local development server: serves public/ and forwards /api/* to the same handler Vercel runs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHandler } from './app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function serveStatic(res, pathname) {
  const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (file.startsWith(PUBLIC)) {
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': `${MIME[extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
      return;
    } catch { /* fall through to 404 */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

export function createLocalServer({ url, authToken } = {}) {
  const handle = createHandler({ url, authToken });

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (!requestUrl.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          return res.end();
        }
        return await serveStatic(res, requestUrl.pathname);
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await handle(new Request(requestUrl, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  });

  server.on('close', () => handle.close());
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const url = process.env.TURSO_DATABASE_URL || `file:${join(ROOT, 'data', 'typemaster.db')}`;
  createLocalServer({ url, authToken: process.env.TURSO_AUTH_TOKEN })
    .listen(port, () => console.log(`Type Master running at http://localhost:${port}`));
}
