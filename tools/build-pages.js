// Build the GitHub Pages version: a folder of static files that runs the whole
// game in the browser (the host's tab runs the room, see public/js/p2p.js).
//
//   node tools/build-pages.js [outDir]      default: dist-pages
//
// The layout mirrors the Node server's URLs, so the same relative imports work
// in both: index.html, js/, css/, shared/, server/ (the game rules only) and
// vendor/three/.

import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist-pages'));
if (OUT === ROOT || !OUT.startsWith(path.sep) || OUT.split(path.sep).length < 3) {
  console.error('Vägrar bygga till', OUT);
  process.exit(1);
}

const SERVER_ONLY = new Set(['server.js', 'static.js']);   // Node only: HTTP, sockets, files
const THREE = path.join(ROOT, 'node_modules', 'three');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Client, without the development harness pages.
await cp(path.join(ROOT, 'public'), OUT, {
  recursive: true,
  filter: (src) => !src.startsWith(path.join(ROOT, 'public', 'dev')),
});
await cp(path.join(ROOT, 'shared'), path.join(OUT, 'shared'), { recursive: true });

// The game rules, which the host's tab runs in a worker.
await mkdir(path.join(OUT, 'server'), { recursive: true });
for (const f of await readdir(path.join(ROOT, 'server'))) {
  if (f.endsWith('.js') && !SERVER_ONLY.has(f)) await cp(path.join(ROOT, 'server', f), path.join(OUT, 'server', f));
}

// three.js: the build plus the add-ons the scene imports.
await mkdir(path.join(OUT, 'vendor', 'three', 'build'), { recursive: true });
for (const f of ['three.module.js', 'three.core.js']) {
  await cp(path.join(THREE, 'build', f), path.join(OUT, 'vendor', 'three', 'build', f));
}
for (const d of ['postprocessing', 'shaders', 'utils']) {
  await cp(path.join(THREE, 'examples', 'jsm', d), path.join(OUT, 'vendor', 'three', 'examples', 'jsm', d), { recursive: true });
}
await cp(path.join(THREE, 'LICENSE'), path.join(OUT, 'vendor', 'three', 'LICENSE'));

// Serve files as they are (no Jekyll processing on GitHub Pages).
await writeFile(path.join(OUT, '.nojekyll'), '');

console.log('Pages-versionen byggd i', OUT);
