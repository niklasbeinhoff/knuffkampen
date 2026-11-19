// Dev only: serves the client files without the game server, for the
// harness pages under public/dev/. Run: npm run dev:static

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/static.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3100;

http.createServer(createStaticHandler(root, { dev: true })).listen(port, '127.0.0.1', () => {
  console.log(`Knuffkampen dev-static: http://localhost:${port}/dev/`);
});
