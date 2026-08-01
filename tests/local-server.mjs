import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.argv[2] || 8765);
const host = String(process.argv[3] || '127.0.0.1');
const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.txt':'text/plain; charset=utf-8'
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://local.test').pathname);
    const requested = resolve(root, `.${pathname === '/' ? '/Warranty App.html' : pathname}`);
    if (requested !== root && !requested.startsWith(root + sep)) throw new Error('outside root');
    const info = await stat(requested);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': mime[extname(requested).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    response.end(await readFile(requested));
  } catch (_error) {
    response.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
    response.end('Not found');
  }
}).listen(port, host);
