// Static file handler shared by the game server and the dev harness server.
// Serves only: public/, shared/ and the three.js build + addons from node_modules.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, text) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/**
 * @param {string} rootDir absolute path of the project root
 * @param {{ dev?: boolean }} [opts] dev: also serve the harness pages under /dev/
 */
export function createStaticHandler(rootDir, { dev = false } = {}) {
  const mounts = [
    ['/vendor/three/build/', path.join(rootDir, 'node_modules', 'three', 'build'), true],
    ['/vendor/three/examples/jsm/', path.join(rootDir, 'node_modules', 'three', 'examples', 'jsm'), true],
    ['/shared/', path.join(rootDir, 'shared'), false],
    ['/', path.join(rootDir, 'public'), false],
  ];

  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (pathname.includes('\0') || pathname.includes('\\')) return send(res, 400, 'Bad request');
    if (pathname === '/') pathname = '/index.html';
    // The harness pages are for development only; the game server does not serve them.
    if (!dev && (pathname === '/dev' || pathname.startsWith('/dev/'))) return send(res, 404, 'Not found');
    // No dotfiles or parent segments, anywhere in the path.
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');

    for (const [prefix, dir, vendor] of mounts) {
      if (!pathname.startsWith(prefix)) continue;
      const file = path.resolve(dir, pathname.slice(prefix.length));
      if (!file.startsWith(dir + path.sep)) return send(res, 404, 'Not found');
      const type = MIME[path.extname(file).toLowerCase()];
      if (!type) return send(res, 404, 'Not found');

      let info;
      try {
        info = await stat(file);
      } catch {
        return send(res, 404, 'Not found');
      }
      if (!info.isFile()) return send(res, 404, 'Not found');

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        'Cache-Control': vendor ? 'public, max-age=86400' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }
    send(res, 404, 'Not found');
  };
}
