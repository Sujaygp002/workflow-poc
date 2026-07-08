import { connect } from './cdp.mjs';
import { injectSetters } from './cdp-extra.mjs';
const p = await connect({ port: 9222 });
await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await p.navigate('http://localhost:8791/builder/workflows');
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const hasPhase = await p.evaluate("document.body.innerText.includes('Phase 1')");
  const hasFor = await p.evaluate("document.body.innerText.includes('For each onboarded agency')");
  if (hasPhase || hasFor) { console.log('READY after', i+1, 's', 'phase1:', hasPhase, 'forEach:', hasFor); break; }
  if (i === 19) console.log('NOT READY after 20s');
}
await injectSetters(p);
const views = await p.evaluate("[...document.querySelectorAll('button')].filter(b=>/^View$/.test((b.textContent||'').trim())).map(b=>b.textContent.trim())");
console.log('exactViewButtons:', JSON.stringify(views));
const anyView = await p.evaluate("[...document.querySelectorAll('button')].filter(b=>/View/i.test(b.textContent||'')).map(b=>b.textContent.trim())");
console.log('anyViewButtons:', JSON.stringify(anyView));
const boxes = await p.evaluate("[...document.querySelectorAll('*')].filter(d=>/Contact Agency to Upload|Update Object Module/.test(d.textContent||'') && d.children.length<6).map(d=>d.textContent.trim().slice(0,60))");
console.log('taskBoxes:', JSON.stringify(boxes.slice(0,10)));
await p.send('Page.captureScreenshot', { format: 'png' }).then(({data}) => import('node:fs').then(fs => fs.writeFileSync('/tmp/smoke2.png', Buffer.from(data,'base64'))));
await new Promise(r => setTimeout(r, 300));
p.close(); process.exit(0);
