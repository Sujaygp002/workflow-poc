// Full local server for the UI E2E: serves the built dist/ (static + SPA
// rewrites from vercel.json) AND the api/ Vercel handlers via the same routing
// the shim uses. Single origin so the SPA's relative /api/* fetches resolve.
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const API_DIR = path.join(ROOT, 'api');
const DIST_DIR = path.join(ROOT, 'dist');

async function load(rel) {
  const mod = await import(pathToFileURL(path.join(API_DIR, rel)).href);
  return mod.default;
}

const ROUTES = [
  [/^\/api\/auth\/?$/, 'auth/index.js', () => ({})],
  [/^\/api\/workflows\/bulk-upload\/start\/?$/, 'workflows/bulk-upload/start.js', () => ({})],
  [/^\/api\/workflows\/?$/, 'workflows/index.js', () => ({})],
  [/^\/api\/workflow-runs\/?$/, 'workflow-runs/index.js', () => ({})],
  [/^\/api\/workflow-runs\/([^/]+)\/?$/, 'workflow-runs/[id].js', (m) => ({ id: decodeURIComponent(m[1]) })],
  [/^\/api\/work-items\/?$/, 'work-items/index.js', () => ({})],
  [/^\/api\/work-items\/([^/]+)\/complete\/?$/, 'work-items/[taskRunId]/complete.js', (m) => ({ taskRunId: decodeURIComponent(m[1]) })],
  [/^\/api\/patients\/([^/]+)\/?$/, 'patients/[id].js', (m) => ({ id: decodeURIComponent(m[1]) })],
  [/^\/api\/patients\/?$/, 'patients/index.js', () => ({})],
  [/^\/api\/orders\/?$/, 'orders/index.js', () => ({})],
  [/^\/api\/reference-data\/?$/, 'reference-data/index.js', () => ({})],
  [/^\/api\/area-intake\/?$/, 'area-intake/index.js', () => ({})],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveFile(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // ── API routes ──
  if (pathname.startsWith('/api/')) {
    let matched = null;
    let params = {};
    for (const [re, rel, extract] of ROUTES) {
      const m = pathname.match(re);
      if (m) { matched = rel; params = extract(m); break; }
    }
    if (!matched) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `No route for ${pathname}` }));
      return;
    }
    req.query = { ...params };
    for (const [k, v] of url.searchParams) req.query[k] = v;
    try {
      const handler = await load(matched);
      await handler(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }));
    }
    return;
  }

  // ── static + SPA rewrites (mirror vercel.json) ──
  if (pathname === '/worker' || pathname.startsWith('/worker/')) {
    serveFile(res, path.join(DIST_DIR, 'worker.html'));
    return;
  }
  // Any path with a file extension -> try the real file.
  if (/\.\w+$/.test(pathname)) {
    const filePath = path.join(DIST_DIR, decodeURIComponent(pathname));
    if (serveFile(res, filePath)) return;
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  // Everything else -> SPA index.html.
  serveFile(res, path.join(DIST_DIR, 'index.html'));
});

const PORT = Number(process.env.SERVER_PORT || 8791);
// Long-running handlers (bulk upload appends + engine automation inside one
// POST) exceed node's default 300s requestTimeout, and the default 5s
// keepAliveTimeout races pooled client sockets into hangs. Disable both for
// this local runner (Vercel governs its own limits in production).
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
server.listen(PORT, () => console.log(`dev-full-server listening on http://localhost:${PORT}`));
