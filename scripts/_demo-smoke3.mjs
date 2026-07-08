import { connect } from './cdp.mjs';
import { injectSetters, waitForText, sleep } from './cdp-extra.mjs';
const p = await connect({ port: 9222 });
await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await p.navigate('http://localhost:8791/builder/workflows');
await waitForText(p, 'For each onboarded agency', { timeout: 15000 });
await injectSetters(p);
await sleep(500);
// click View for Contact Agency
const c1 = await p.evaluate(`(() => {
  const boxes = [...document.querySelectorAll('div')].filter(d => (d.textContent||'').includes('Contact Agency to Upload'));
  let best = null;
  for (const b of boxes) { const v=[...b.querySelectorAll('button')].find(x=>/^\\s*View/i.test((x.textContent||'').trim())); if(v){const n=b.querySelectorAll('*').length; if(!best||n<best.n)best={v,n};} }
  if(best){best.v.click();return true;} return false;
})()`);
console.log('clicked Contact View:', c1);
await sleep(1500);
const innerC = await p.evaluate("[...document.querySelectorAll('*')].some(e=>/Call agency|Email agency|Text agency/.test(e.textContent||''))");
console.log('contact inner actions visible:', innerC);
await p.send('Page.captureScreenshot', { format: 'png' }).then(({data}) => import('node:fs').then(fs => fs.writeFileSync('/tmp/smoke3-contact.png', Buffer.from(data,'base64'))));
// collapse
await p.evaluate(`[...document.querySelectorAll('button')].filter(b=>/▲/.test(b.textContent||'')).forEach(b=>b.click()); true`);
await sleep(800);
// click View for Update Object Module
const c2 = await p.evaluate(`(() => {
  const boxes = [...document.querySelectorAll('div')].filter(d => (d.textContent||'').includes('Update Object Module'));
  let best = null;
  for (const b of boxes) { const v=[...b.querySelectorAll('button')].find(x=>/^\\s*View/i.test((x.textContent||'').trim())); if(v){const n=b.querySelectorAll('*').length; if(!best||n<best.n)best={v,n};} }
  if(best){best.v.click();return true;} return false;
})()`);
console.log('clicked Update View:', c2);
await sleep(1500);
const innerU = await p.evaluate("[...document.querySelectorAll('*')].some(e=>/AI extract|Create patient|Review record|Check \\/ create/.test(e.textContent||''))");
console.log('update inner steps visible:', innerU);
await p.send('Page.captureScreenshot', { format: 'png' }).then(({data}) => import('node:fs').then(fs => fs.writeFileSync('/tmp/smoke3-update.png', Buffer.from(data,'base64'))));
await sleep(300);
p.close(); process.exit(0);
