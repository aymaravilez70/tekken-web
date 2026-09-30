const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4321;
const ISO_PATH = path.resolve(__dirname, '..', 'Tekken 6 (USA) (En,Fr,De,Es,It,Ru) (2014-05-20) (PSP) (PSN).iso');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.iso': 'application/octet-stream',
  '.data': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
  // Essential headers for SharedArrayBuffer / Multi-threading WebAssembly in modern browsers
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // Serve the Tekken 6 ISO directly with full Range header support
  if (pathname === '/tekken6.iso') {
    if (!fs.existsSync(ISO_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('ISO file not found');
      return;
    }

    const stat = fs.statSync(ISO_PATH);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Content-Type': 'application/octet-stream'
        });
        res.end();
        return;
      }

      const chunkSize = (end - start) + 1;
      const fileStream = fs.createReadStream(ISO_PATH, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'application/octet-stream'
      });
      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream'
      });
      fs.createReadStream(ISO_PATH).pipe(res);
    }
    return;
  }

  // Serve static files in tekken-web
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[TEKKEN 6 WEB] Server running at http://127.0.0.1:${PORT}/`);
  console.log(`[TEKKEN 6 WEB] ISO verified at: ${ISO_PATH}`);
});
