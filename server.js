/**
 * Static server for Qwix - no dependencies, no build step.
 *
 * The game is two <script> tags and a canvas, so all this has to do is hand out
 * files with the right content type and refuse to walk out of the directory.
 *
 *   npm start            # http://localhost:3000
 *   PORT=8080 npm start
 *
 * Opening index.html straight off the disk (file://) works too - nothing here
 * is fetched, so there is no origin to trip over. The only thing a server buys
 * you is a real http:// origin for localStorage.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3333;

const TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function reply(res, status, body, type) {
  const headers = { 'Content-Type': type || 'text/plain; charset=UTF-8' };
  headers['Content-Length'] = Buffer.byteLength(body);
  headers['Cache-Control'] = 'no-cache';
  res.writeHead(status, headers);
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return reply(res, 405, 'only GET and HEAD are served here\n');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return reply(res, 400, 'bad request\n');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT and refuse anything that climbs back out of it, so a
  // crafted ../ can never reach the rest of the disk.
  const file = path.join(ROOT, path.normalize(pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    return reply(res, 403, 'forbidden\n');
  }

  fs.readFile(file, (err, data) => {
    if (err) return reply(res, 404, 'not found: ' + pathname + '\n');
    reply(res, 200, data, TYPES[path.extname(file).toLowerCase()]);
  });
});

server.listen(PORT, () => {
  console.log(`Qwix running at http://localhost:${PORT}`);
  console.log('arrows / wasd to move, hold shift for a slow draw, p to pause');
});
