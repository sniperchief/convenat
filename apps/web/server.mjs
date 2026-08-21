/**
 * A static file server for the demo surface.
 *
 *   node server.mjs            # serves ./public on :5173
 *   WEB_PORT=3000 node server.mjs
 *
 * Node's own `http` and nothing else. A build tool here would add a dependency
 * tree, a config file and a compile step to a page that is four files of plain
 * HTML and JavaScript — and the milestone brief is explicit that hours are not
 * to go into the frontend. The trade is stated rather than implied: there is no
 * bundler, no JSX and no framework, and the page is written accordingly.
 *
 * It serves files and does nothing else. There is no proxy to the API — the
 * browser calls the backend directly and the backend answers with an explicit
 * CORS origin — so this process holds no secret, has no route that can be
 * confused for an API route, and can be replaced by any static host.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, 'public');
const PORT = Number.parseInt(process.env.WEB_PORT ?? '5173', 10);
const HOST = process.env.WEB_HOST ?? '127.0.0.1';

/** The API origin the page talks to, injected so it is configured in one place. */
const API_BASE = process.env.WEB_API_BASE ?? 'http://127.0.0.1:8080';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Resolve a request path to a file inside ROOT, or null.
 *
 * The containment check is the whole point: a request for
 * `/../../.env` must not escape the served directory. `normalize` collapses the
 * traversal and the prefix test rejects anything that still lands outside.
 */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = join(ROOT, relative);

  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  if (!existsSync(candidate)) return null;
  if (statSync(candidate).isDirectory()) {
    const index = join(candidate, 'index.html');
    return existsSync(index) ? index : null;
  }
  return candidate;
}

const server = createServer((request, response) => {
  const url = request.url ?? '/';

  // The one dynamic response: configuration the page needs but must not have
  // hard-coded, for the same reason the backend takes contract addresses from a
  // manifest rather than a constant.
  if (url === '/config.js') {
    response.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    response.end(`window.COVENANT_API_BASE = ${JSON.stringify(API_BASE)};\n`);
    return;
  }

  const file = resolveFile(url === '/' ? '/index.html' : url);
  if (file === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`covenant web  →  http://${HOST}:${PORT}`);
  console.log(`api base      →  ${API_BASE}`);
});
