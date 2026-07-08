// Extra CDP helpers layered on top of scripts/cdp.mjs for the phase-1 demo
// recorder: a screencast-driven frame grabber (writes numbered PNG frames while a
// scene runs), a fixed title-banner injector, React-aware value setters, click /
// type / wait-for-text primitives, and a DOM.setFileInputFiles wrapper. All of
// this drives the REAL app over CDP — nothing here mocks a screen.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Frame recorder ────────────────────────────────────────────────────────────
// A timed Page.captureScreenshot poll writes a numbered JPEG per tick. This is a
// deterministic, gap-free frame source (no dependence on screencast change-events),
// so a static page still yields a steady FPS. Frames feed ffmpeg per scene.
export function makeRecorder(p, { fps = 3, quality = 72 } = {}) {
  let frameDir = null;
  let frameIdx = 0;
  let capturing = false;
  let timer = null;
  let inFlight = false;
  const frameMs = Math.round(1000 / fps);

  async function grab() {
    if (!capturing || !frameDir || inFlight) return;
    inFlight = true;
    try {
      const { data } = await p.send('Page.captureScreenshot', { format: 'jpeg', quality });
      writeFrame(frameDir, frameIdx++, data);
    } catch { /* transient — skip this frame */ }
    inFlight = false;
  }

  async function start(dir) {
    frameDir = dir;
    frameIdx = 0;
    capturing = true;
    fs.mkdirSync(dir, { recursive: true });
    await grab(); // seed frame 0 immediately
    timer = setInterval(grab, frameMs);
  }

  async function stop() {
    capturing = false;
    if (timer) { clearInterval(timer); timer = null; }
    // let any in-flight capture settle
    for (let i = 0; i < 10 && inFlight; i += 1) await sleep(20);
    const dir = frameDir;
    const count = frameIdx;
    frameDir = null;
    return { dir, count };
  }

  return { start, stop, grab, frameMs, get fps() { return fps; } };
}

function writeFrame(dir, idx, base64) {
  const name = `f${String(idx).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
}

// ── Title banner ────────────────────────────────────────────────────────────
// A fixed dark bar pinned to the TOP of the viewport, pushing page content down
// so it never covers the content being demonstrated (body gets a top margin).
export async function setBanner(p, text, sub = '') {
  const js = `(() => {
    const ID = '__demo_banner__';
    let bar = document.getElementById(ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = ID;
      document.body.appendChild(bar);
      const style = document.createElement('style');
      style.id = ID + '_style';
      style.textContent = 'body{margin-top:64px !important;} #' + ID + '{position:fixed;top:0;left:0;right:0;height:64px;z-index:2147483647;background:#0f172a;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:6px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);border-bottom:2px solid #6d28d9;}';
      document.head.appendChild(style);
    }
    bar.innerHTML = '<div style="font-size:17px;font-weight:800;letter-spacing:.2px;line-height:1.15">' +
      ${JSON.stringify(text)} + '</div>' +
      (${JSON.stringify(sub)} ? '<div style="font-size:12px;opacity:.8;margin-top:2px">' + ${JSON.stringify(sub)} + '</div>' : '');
    return true;
  })()`;
  await p.evaluate(js);
}

export async function clearBanner(p) {
  await p.evaluate(`(() => {
    const ID='__demo_banner__';
    document.getElementById(ID)?.remove();
    document.getElementById(ID+'_style')?.remove();
    document.body.style.marginTop='';
    return true;
  })()`).catch(() => {});
}

// ── React-aware setters / interactions ────────────────────────────────────────
export const REACT_SETTER = `
window.__demo = window.__demo || (() => {
  function reactSet(el, value) {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function byText(sel, text) {
    return [...document.querySelectorAll(sel)].find(e => (e.textContent||'').trim() === text)
      || [...document.querySelectorAll(sel)].find(e => (e.textContent||'').includes(text));
  }
  function setInputByPlaceholder(ph, value) {
    const el = [...document.querySelectorAll('input,textarea')].find(i => (i.placeholder||'').toLowerCase().includes(ph.toLowerCase()));
    if (!el) return false; return reactSet(el, value);
  }
  function setInputByLabel(labelText, value) {
    const label = [...document.querySelectorAll('label')].find(l => (l.textContent||'').toLowerCase().includes(labelText.toLowerCase()));
    if (!label) return false;
    const el = label.querySelector('input,textarea,select');
    if (!el) return false; return reactSet(el, value);
  }
  function setInputByAutocomplete(ac, value) {
    const el = document.querySelector('input[autocomplete="' + ac + '"]');
    if (!el) return false; return reactSet(el, value);
  }
  function clickByText(sel, text) {
    const el = byText(sel, text); if (!el) return false; el.click(); return true;
  }
  function highlight(sel, text) {
    const el = text ? byText(sel, text) : document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({block:'center', behavior:'instant'});
    const old = el.style.outline;
    el.style.outline = '3px solid #f59e0b'; el.style.outlineOffset='2px';
    setTimeout(() => { el.style.outline = old; }, 1400);
    return true;
  }
  function seedToken(kind, token) {
    const map = { worker: 'cc_worker_token', hhah: 'cc_hhah_token', pg: 'cc_pg_token' };
    try { sessionStorage.setItem(map[kind], token); return true; } catch { return false; }
  }
  return { reactSet, byText, setInputByPlaceholder, setInputByLabel, setInputByAutocomplete, clickByText, highlight, seedToken };
})();
true;
`;

export async function injectSetters(p) {
  await p.evaluate(REACT_SETTER);
}

export async function clickText(p, sel, text) {
  return p.evaluate(`window.__demo.clickByText(${JSON.stringify(sel)}, ${JSON.stringify(text)})`);
}

export async function typePlaceholder(p, ph, value) {
  return p.evaluate(`window.__demo.setInputByPlaceholder(${JSON.stringify(ph)}, ${JSON.stringify(value)})`);
}

export async function typeAutocomplete(p, ac, value) {
  return p.evaluate(`window.__demo.setInputByAutocomplete(${JSON.stringify(ac)}, ${JSON.stringify(value)})`);
}

export async function highlight(p, sel, text = '') {
  return p.evaluate(`window.__demo.highlight(${JSON.stringify(sel)}, ${JSON.stringify(text)})`);
}

// Wait (bounded) for a text to appear on the page. Polls OFF-camera in the sense
// that we keep the frame recorder running but do not exceed the caller's budget.
export async function waitForText(p, text, { timeout = 8000, interval = 250 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await p.evaluate(`document.body && document.body.innerText.includes(${JSON.stringify(text)})`);
    if (ok) return true;
    await sleep(interval);
  }
  return false;
}

// DOM.setFileInputFiles: attach real files to the Nth file input on the page.
export async function setFileInput(p, index, filePaths) {
  const doc = await p.send('DOM.getDocument', { depth: -1 });
  const q = await p.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  const nodeId = q.nodeIds[index];
  if (!nodeId) throw new Error(`no file input at index ${index} (have ${q.nodeIds.length})`);
  await p.send('DOM.setFileInputFiles', { nodeId, files: filePaths });
  return true;
}

export { sleep };
