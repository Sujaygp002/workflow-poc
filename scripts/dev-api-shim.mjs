// Minimal local HTTP shim that serves the api/ Vercel handlers so the E2E tester
// can curl the API without the Vercel runtime. Routes by path, adapts (req,res),
// and injects req.query the way Vercel's file-based router would.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const API_DIR = path.resolve(process.cwd(), 'api');

async function load(rel) {
  const mod = await import(pathToFileURL(path.join(API_DIR, rel)).href);
  return mod.default;
}

// Route table: [regex over pathname, loader, param extractor].
const ROUTES = [
  [/^\/api\/auth\/?$/, 'auth/index.js', () => ({})],
  [/^\/api\/workflows\/?$/, 'workflows/index.js', () => ({})],
  [/^\/api\/workflow-runs\/?$/, 'workflow-runs/index.js', () => ({})],
  [/^\/api\/workflow-runs\/([^/]+)\/?$/, 'workflow-runs/[id].js', (m) => ({ id: decodeURIComponent(m[1]) })],
  [/^\/api\/work-items\/?$/, 'work-items/index.js', () => ({})],
  [/^\/api\/work-items\/([^/]+)\/complete\/?$/, 'work-items/[taskRunId]/complete.js', (m) => ({ taskRunId: decodeURIComponent(m[1]) })],
  [/^\/api\/patients\/?$/, 'patients/index.js', () => ({})],
  [/^\/api\/orders\/?$/, 'orders/index.js', () => ({})],
  [/^\/api\/reference-data\/?$/, 'reference-data/index.js', () => ({})],
  [/^\/api\/area-intake\/?$/, 'area-intake/index.js', () => ({})],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  let matched = null;
  let params = {};
  for (const [re, rel, extract] of ROUTES) {
    const m = pathname.match(re);
    if (m) { matched = rel; params = extract(m); break; }
  }
  if (!matched) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `No shim route for ${pathname}` }));
    return;
  }
  // Vercel-style req.query = path params + search params.
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
});

const PORT = Number(process.env.SHIM_PORT || 8787);
server.listen(PORT, () => console.log(`dev-api-shim listening on http://localhost:${PORT}`));
