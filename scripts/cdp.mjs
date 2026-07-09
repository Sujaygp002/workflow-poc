// Minimal CDP client over the bundled `ws` module. Connects to a headless
// Chrome page target, exposes navigate / eval / screenshot helpers.
import WebSocket from 'ws';

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

export async function connect({ port = 9222, newTab = false } = {}) {
  // Pick (or create) a page target. With newTab:true always open a FRESH page
  // target and connect to it (used by the production demo recorder to keep a
  // long-running upload tab alive while other scenes record from the main tab).
  let targets = await httpJson(`http://localhost:${port}/json`);
  let page = newTab ? null : targets.find((t) => t.type === 'page');
  if (!page) {
    // Newer Chrome requires PUT for /json/new (GET returns 405).
    const res = await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })
      .catch(() => fetch(`http://localhost:${port}/json/new?about:blank`));
    const created = await res.json().catch(() => null);
    if (created?.webSocketDebuggerUrl) {
      page = created;
    } else {
      targets = await httpJson(`http://localhost:${port}/json`);
      page = targets.find((t) => t.type === 'page');
    }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let id = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  function send(method, params = {}) {
    id += 1;
    const thisId = id;
    return new Promise((resolve, reject) => {
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  async function navigate(url) {
    await send('Page.navigate', { url });
    // Wait for load.
    await new Promise((r) => setTimeout(r, 1200));
  }

  async function evaluate(expression, { awaitPromise = true } = {}) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      throw new Error('EVAL ERROR: ' + JSON.stringify(result.exceptionDetails));
    }
    return result.result.value;
  }

  async function screenshot(path) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const fs = await import('node:fs');
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
  }

  function close() { ws.close(); }

  return { send, navigate, evaluate, screenshot, close };
}
