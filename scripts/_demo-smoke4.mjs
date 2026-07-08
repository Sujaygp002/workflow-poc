import { connect } from './cdp.mjs';
import { injectSetters, waitForText, sleep } from './cdp-extra.mjs';
const p = await connect({ port: 9222 });
await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await p.navigate('http://localhost:8791/builder/workflows');
await waitForText(p, 'For each onboarded agency', { timeout: 15000 });
await injectSetters(p);
await sleep(500);
// expand both View toggles
await p.evaluate(`(() => {
  for (const name of ['Contact Agency to Upload','Update Object Module']) {
    const boxes=[...document.querySelectorAll('div')].filter(d=>(d.textContent||'').includes(name));
    let best=null; for(const b of boxes){const v=[...b.querySelectorAll('button')].find(x=>/^\\s*View/i.test((x.textContent||'').trim())); if(v){const n=b.querySelectorAll('*').length; if(!best||n<best.n)best={v,n};}}
    if(best)best.v.click();
  } return true;
})()`);
await sleep(1500);
// scroll to reveal contact inner actions
await p.evaluate("window.scrollTo(0, 520); true");
await sleep(600);
await p.send('Page.captureScreenshot', { format: 'png' }).then(({data}) => import('node:fs').then(fs => fs.writeFileSync('/tmp/smoke4-a.png', Buffer.from(data,'base64'))));
await p.evaluate("window.scrollTo(0, 900); true");
await sleep(600);
await p.send('Page.captureScreenshot', { format: 'png' }).then(({data}) => import('node:fs').then(fs => fs.writeFileSync('/tmp/smoke4-b.png', Buffer.from(data,'base64'))));
await p.evaluate("window.scrollTo(0, 1350); true");
await sleep(600);
await p.send('Page.captureScreenshot', { format: 'png' }).then(({data}) => import('node:fs').then(fs => fs.writeFileSync('/tmp/smoke4-c.png', Buffer.from(data,'base64'))));
const maxScroll = await p.evaluate("document.body.scrollHeight");
console.log('scrollHeight:', maxScroll);
await sleep(200); p.close(); process.exit(0);
